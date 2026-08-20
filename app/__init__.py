from flask import Flask
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager

from .config import Config

db = SQLAlchemy()
login_manager = LoginManager()
login_manager.login_view = "auth.login_get"


def create_app():
    app = Flask(__name__)
    app.config.from_object(Config)

    db.init_app(app)
    login_manager.init_app(app)

    from .routes.auth import bp as auth_bp
    from .routes.dashboard import bp as dashboard_bp
    from .routes.account import bp as account_bp
    from .routes.invites import bp as invites_bp
    from .routes.admin import bp as admin_bp
    from .routes.api import bp as api_bp
    from .routes.extension_bp import bp as extension_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(dashboard_bp)
    app.register_blueprint(account_bp)
    app.register_blueprint(invites_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(api_bp)
    app.register_blueprint(extension_bp)

    with app.app_context():
        from . import models  # noqa
        db.create_all()

        db.session.execute(db.text("PRAGMA journal_mode=WAL"))
        db.session.commit()

        # db.create_all() only creates missing tables, not missing columns on existing
        # tables — this project has no Alembic, so new User columns need a manual guard.
        existing_user_columns = {row[1] for row in db.session.execute(db.text("PRAGMA table_info(user)"))}
        if "invite_email" not in existing_user_columns:
            db.session.execute(db.text("ALTER TABLE user ADD COLUMN invite_email VARCHAR(255)"))
        if "auto_invite_enabled" not in existing_user_columns:
            db.session.execute(db.text("ALTER TABLE user ADD COLUMN auto_invite_enabled BOOLEAN NOT NULL DEFAULT 1"))
        if "invite_delay_ms" not in existing_user_columns:
            db.session.execute(db.text("ALTER TABLE user ADD COLUMN invite_delay_ms INTEGER NOT NULL DEFAULT 4000"))
        db.session.commit()

        # Seed admin df/df
        from .models import User
        admin = User.query.filter_by(username="df").first()
        if not admin:
            admin = User(username="df", is_admin=True, is_banned=False)
            admin.set_password("df")
            admin.generate_api_key()
            db.session.add(admin)
            db.session.commit()

        # Backfill api_key for any user that doesn't have one yet
        users_without_key = User.query.filter((User.api_key.is_(None)) | (User.api_key == "")).all()
        for u in users_without_key:
            u.generate_api_key()
        if users_without_key:
            db.session.commit()

    return app
