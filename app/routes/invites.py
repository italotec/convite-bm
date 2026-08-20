from flask import Blueprint, render_template, request
from flask_login import login_required, current_user

from .. import db
from ..models import Invite

bp = Blueprint("invites", __name__, url_prefix="/convites")


@bp.route("")
@login_required
def invites_page():
    q = Invite.query.filter_by(user_id=current_user.id)

    search = (request.args.get("q") or "").strip()
    if search:
        like = f"%{search}%"
        q = q.filter(db.or_(Invite.business_id.ilike(like), Invite.business_name.ilike(like)))

    status = (request.args.get("status") or "").strip()
    if status in ("sent", "failed"):
        q = q.filter_by(status=status)

    rows = q.order_by(Invite.created_at.desc()).limit(500).all()

    return render_template(
        "invites.html",
        title="Convites",
        rows=rows,
        search=search,
        status=status,
    )
