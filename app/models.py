import secrets
from datetime import datetime
from zoneinfo import ZoneInfo

from flask_login import UserMixin
from werkzeug.security import generate_password_hash, check_password_hash

from . import db, login_manager

_SP = ZoneInfo("America/Sao_Paulo")


def _now_sp():
    return datetime.now(_SP)


class User(db.Model, UserMixin):
    id = db.Column(db.Integer, primary_key=True)

    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)

    is_admin = db.Column(db.Boolean, default=False, nullable=False)
    is_banned = db.Column(db.Boolean, default=False, nullable=False)

    api_key = db.Column(db.String(64), unique=True, nullable=True, index=True)

    # Legacy: single email every invite used to be sent to, before per-BM disposable mailboxes
    # (see BusinessMailbox). No longer read or written; kept only so historical Invite rows that
    # predate this column's retirement still resolve correctly if ever cross-referenced.
    invite_email = db.Column(db.String(255), nullable=True)

    auto_invite_enabled = db.Column(db.Boolean, default=True, nullable=False)
    invite_delay_ms = db.Column(db.Integer, default=4000, nullable=False)

    created_at = db.Column(db.DateTime, default=_now_sp, nullable=False)

    invites = db.relationship("Invite", backref="user", lazy=True, cascade="all, delete-orphan")
    mailboxes = db.relationship("BusinessMailbox", backref="user", lazy=True, cascade="all, delete-orphan")

    def generate_api_key(self):
        self.api_key = secrets.token_urlsafe(32)

    def set_password(self, pw: str):
        self.password_hash = generate_password_hash(pw)

    def check_password(self, pw: str) -> bool:
        return check_password_hash(self.password_hash, pw)


@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))


class Invite(db.Model):
    """One invite attempt (auto or manual) for a single (user, business_id) pair.
    Dedup for the auto-scan is `status == 'sent'` on this pair — a BM already
    successfully invited is never retried automatically."""

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)

    business_id = db.Column(db.String(64), nullable=False, index=True)
    business_name = db.Column(db.String(255), default="", nullable=False)
    business_picture_url = db.Column(db.Text, default="", nullable=False)

    email = db.Column(db.String(255), nullable=False)  # BusinessMailbox address this invite was sent to

    status = db.Column(db.String(16), default="sent", nullable=False)  # sent | failed
    role_request_id = db.Column(db.String(64), default="", nullable=False)
    role_request_status = db.Column(db.String(32), default="", nullable=False)  # PENDING, etc
    expiration_time = db.Column(db.Integer, nullable=True)
    error_message = db.Column(db.Text, default="", nullable=False)

    fb_actor_id = db.Column(db.String(64), default="", nullable=False)

    adspower_profile_id = db.Column(db.String(64), default="", nullable=False)
    adspower_serial = db.Column(db.String(64), default="", nullable=False)

    trigger = db.Column(db.String(16), default="auto", nullable=False)  # auto | manual

    created_at = db.Column(db.DateTime, default=_now_sp, nullable=False, index=True)

    __table_args__ = (
        db.Index("ix_invite_user_business", "user_id", "business_id"),
    )


class BusinessMailbox(db.Model):
    """One disposable inbox per (user, business_id). Allocated on the first invite attempt and
    reused forever after, so a BM's address never changes across retries."""

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)

    business_id = db.Column(db.String(64), nullable=False, index=True)
    business_name = db.Column(db.String(255), default="", nullable=False)

    address = db.Column(db.String(255), unique=True, nullable=False)

    created_at = db.Column(db.DateTime, default=_now_sp, nullable=False)

    __table_args__ = (
        db.UniqueConstraint("user_id", "business_id", name="uq_mailbox_user_business"),
    )
