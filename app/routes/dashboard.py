from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from flask import Blueprint, render_template
from flask_login import login_required, current_user

from ..models import Invite

bp = Blueprint("dashboard", __name__)

_SP = ZoneInfo("America/Sao_Paulo")


@bp.route("/")
@login_required
def dashboard():
    q = Invite.query.filter_by(user_id=current_user.id)

    total_sent = q.filter_by(status="sent").count()
    total_failed = q.filter_by(status="failed").count()
    unique_bms = (
        Invite.query.with_entities(Invite.business_id)
        .filter_by(user_id=current_user.id, status="sent")
        .distinct()
        .count()
    )

    today_start = datetime.now(_SP).replace(hour=0, minute=0, second=0, microsecond=0)
    sent_today = q.filter(Invite.status == "sent", Invite.created_at >= today_start).count()

    recent_invites = q.order_by(Invite.created_at.desc()).limit(20).all()

    return render_template(
        "dashboard.html",
        title="Dashboard",
        total_sent=total_sent,
        total_failed=total_failed,
        unique_bms=unique_bms,
        sent_today=sent_today,
        recent_invites=recent_invites,
    )
