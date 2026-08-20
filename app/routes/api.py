from flask import Blueprint, request, jsonify, current_app
from flask_login import current_user

from .. import db
from ..models import User, Invite

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
        "email": user.invite_email or "",
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
        return jsonify({"ok": True, "already": []})

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
    return jsonify({"ok": True, "already": already})


@bp.route("/invites", methods=["POST"])
def create_invite():
    user, err = _authenticate()
    if err:
        return err

    if not user.invite_email:
        return jsonify({"ok": False, "error": "Usuário sem e-mail de convite configurado em /conta."}), 400

    body = request.get_json(silent=True)
    if not body:
        return jsonify({"ok": False, "error": "Request body must be valid JSON with Content-Type: application/json."}), 400

    business_id = str(body.get("business_id") or "").strip()
    if not business_id:
        return jsonify({"ok": False, "error": "business_id is required."}), 400

    status = str(body.get("status") or "").strip()
    if status not in ("sent", "failed"):
        return jsonify({"ok": False, "error": "status must be 'sent' or 'failed'."}), 400

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
        email=user.invite_email,
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
