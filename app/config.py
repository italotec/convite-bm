import os
from datetime import timedelta


class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-change-me")
    SQLALCHEMY_DATABASE_URI = os.getenv("DATABASE_URL", "sqlite:///app.db")
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {
        "pool_size": 20,
        "max_overflow": 40,
        "pool_timeout": 30,
        "pool_recycle": 1800,
        "pool_pre_ping": True,
        "connect_args": {"timeout": 30},
    }

    PERMANENT_SESSION_LIFETIME = timedelta(days=30)
    REMEMBER_COOKIE_DURATION = timedelta(days=30)
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    REMEMBER_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = False
    REMEMBER_COOKIE_SECURE = False

    # Base URL baked into the personalized extension download (config.js + manifest
    # host_permissions). Falls back to request.host_url when unset.
    CONVITE_BASE_URL = os.getenv("CONVITE_BASE_URL", "")

    # Business-level task ids granted on invite — full BM access, no per-asset scoping.
    # Captured from enviarconvitebm.har (BizKitSettingsInvitePeopleModalMutation). Served
    # to the extension via /api/v1/me so a Meta-side change never requires reshipping it.
    BUSINESS_ACCOUNT_TASK_IDS = [
        "926381894526285", "603931664885191", "1327662214465567", "862159105082613",
        "6161001899617846786", "1633404653754086", "967306614466178", "2848818871965443",
        "245181923290198", "388517145453246", "768085000593466", "416103972652535",
    ]
