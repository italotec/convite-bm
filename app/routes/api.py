from flask import Blueprint, request, jsonify, current_app
from flask_login import current_user
from sqlalchemy.exc import IntegrityError

from .. import db
from ..models import User, Invite, BusinessMailbox
from ..services.tempmail import create_mailbox, inbox_url, TempMailError

bp = Blueprint("api", __name__, url_prefix="/api/v1")


def _authenticate():
    """Extract and validate the API key from request headers.

    Returns (user, None) on success or (None, (response, status_code)) on failure —
    the caller can `return err` directly since Flask accepts (body, status) tuples.
    Accepts: Authorization: Bearer <key>  OR  X-API-Key: <key>
    """
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        key = auth_header[7:].strip()
    else:
        key = request.headers.get("X-API-Key", "").strip()

    if not key:
        return None, (jsonify({"ok": False, "error": "Missing API key. Send Authorization: Bearer <key> or X-API-Key: <key>."}), 401)

    user = User.query.filter_by(api_key=key).first()
    if not user:
        return None, (jsonify({"ok": False, "error": "Invalid API key."}), 401)

    if user.is_banned:
        return None, (jsonify({"ok": False, "error": "Account banned."}), 403)

    return user, None


@bp.route("/me")
def me():
    user, err = _authenticate()
    if err:
        return err

    return jsonify({
        "ok": True,
        "username": user.username,
        "auto_invite_enabled": bool(user.auto_invite_enabled),
        "invite_delay_ms": user.invite_delay_ms,
        "business_account_task_ids": current_app.config["BUSINESS_ACCOUNT_TASK_IDS"],
    })


@bp.route("/invites/check", methods=["POST"])
def invites_check():
    user, err = _authenticate()
    if err:
        return err

    body = request.get_json(silent=True) or {}
    business_ids = body.get("business_ids") or []
    if not isinstance(business_ids, list):
        return jsonify({"ok": False, "error": "business_ids must be a list."}), 400
    business_ids = [str(b).strip() for b in business_ids if str(b).strip()]

    if not business_ids:
        return jsonify({"ok": True, "already": [], "mailboxes": {}})

    rows = (
        Invite.query.with_entities(Invite.business_id)
        .filter(
            Invite.user_id == user.id,
            Invite.status == "sent",
            Invite.business_id.in_(business_ids),
        )
        .distinct()
        .all()
    )
    already = [r[0] for r in rows]

    mailbox_rows = BusinessMailbox.query.filter(
        BusinessMailbox.user_id == user.id,
        BusinessMailbox.business_id.in_(business_ids),
    ).all()
    mailboxes = {
        mb.business_id: {"address": mb.address, "inbox_url": inbox_url(mb.address)}
        for mb in mailbox_rows
    }

    return jsonify({"ok": True, "already": already, "mailboxes": mailboxes})


@bp.route("/mailbox", methods=["POST"])
def alloc_mailbox():
    """Allocate (or reuse) the disposable mailbox for one Business Manager. Idempotent — calling
    it again for a BM that already has a mailbox returns the same address (created: false)."""
    user, err = _authenticate()
    if err:
        return err

    body = request.get_json(silent=True) or {}
    business_id = str(body.get("business_id") or "").strip()
    if not business_id:
        return jsonify({"ok": False, "error": "business_id is required."}), 400
    business_name = str(body.get("business_name") or "")[:255]

    existing = BusinessMailbox.query.filter_by(user_id=user.id, business_id=business_id).first()
    if existing:
        return jsonify({
            "ok": True, "address": existing.address, "inbox_url": inbox_url(existing.address), "created": False,
        })

    try:
        address = create_mailbox()
    except TempMailError as e:
        return jsonify({"ok": False, "error": str(e)}), 502

    mailbox = BusinessMailbox(
        user_id=user.id, business_id=business_id, business_name=business_name, address=address,
    )
    db.session.add(mailbox)
    try:
        db.session.commit()
    except IntegrityError:
        # Two concurrent requests raced on the same (user, business_id) — the loser just reuses
        # the winner's row instead of creating (and orphaning) a second mailbox.
        db.session.rollback()
        existing = BusinessMailbox.query.filter_by(user_id=user.id, business_id=business_id).first()
        if existing:
            return jsonify({
                "ok": True, "address": existing.address, "inbox_url": inbox_url(existing.address), "created": False,
            })
        raise

    return jsonify({"ok": True, "address": mailbox.address, "inbox_url": inbox_url(mailbox.address), "created": True})


@bp.route("/invites", methods=["POST"])
def create_invite():
    user, err = _authenticate()
    if err:
        return err

    body = request.get_json(silent=True)
    if not body:
        return jsonify({"ok": False, "error": "Request body must be valid JSON with Content-Type: application/json."}), 400

    business_id = str(body.get("business_id") or "").strip()
    if not business_id:
        return jsonify({"ok": False, "error": "business_id is required."}), 400

    status = str(body.get("status") or "").strip()
    if status not in ("sent", "failed"):
        return jsonify({"ok": False, "error": "status must be 'sent' or 'failed'."}), 400

    mailbox = BusinessMailbox.query.filter_by(user_id=user.id, business_id=business_id).first()
    email = mailbox.address if mailbox else str(body.get("mailbox_address") or "").strip()[:255]
    if not email and status == "sent":
        # A "sent" report must always carry the address the invite actually went to. A "failed"
        # report (e.g. mailbox allocation itself failed, before any invite was attempted) is
        # still logged with an empty email so the row shows up with its error_message.
        return jsonify({"ok": False, "error": "Nenhuma caixa de e-mail alocada para este Business Manager."}), 400

    trigger = str(body.get("trigger") or "manual").strip()
    if trigger not in ("auto", "manual"):
        trigger = "manual"

    expiration_time = body.get("expiration_time")
    try:
        expiration_time = int(expiration_time) if expiration_time is not None else None
    except (TypeError, ValueError):
        expiration_time = None

    invite = Invite(
        user_id=user.id,
        business_id=business_id,
        business_name=str(body.get("business_name") or "")[:255],
        business_picture_url=str(body.get("business_picture_url") or ""),
        email=email,
        status=status,
        role_request_id=str(body.get("role_request_id") or "")[:64],
        role_request_status=str(body.get("role_request_status") or "")[:32],
        expiration_time=expiration_time,
        error_message=str(body.get("error_message") or ""),
        fb_actor_id=str(body.get("fb_actor_id") or "")[:64],
        adspower_profile_id=str(body.get("adspower_profile_id") or "")[:64],
        adspower_serial=str(body.get("adspower_serial") or "")[:64],
        trigger=trigger,
    )
    db.session.add(invite)
    db.session.commit()

    return jsonify({"ok": True, "id": invite.id}), 201
