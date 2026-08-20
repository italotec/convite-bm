import secrets

from flask import Blueprint, render_template, request, redirect, url_for, flash
from flask_login import current_user

from .. import db
from ..models import User, Invite

bp = Blueprint("admin", __name__, url_prefix="/admin")


@bp.before_request
def _guard():
    if not current_user.is_authenticated:
        return redirect(url_for("auth.login_get"))
    if not current_user.is_admin:
        flash("Acesso restrito a administradores.", "error")
        return redirect(url_for("dashboard.dashboard"))


@bp.route("/usuarios")
def admin_users():
    users = User.query.order_by(User.username).all()
    return render_template("admin_users.html", title="Admin — Usuários", users=users)


@bp.route("/usuarios/criar", methods=["POST"])
def create_user():
    username = (request.form.get("username") or "").strip()
    password = (request.form.get("password") or "").strip()

    if not username or not password:
        flash("Usuário e senha são obrigatórios.", "error")
        return redirect(url_for("admin.admin_users"))

    if User.query.filter_by(username=username).first():
        flash("Esse usuário já existe.", "error")
        return redirect(url_for("admin.admin_users"))

    user = User(username=username)
    user.set_password(password)
    user.generate_api_key()
    db.session.add(user)
    db.session.commit()
    flash(f"Usuário {username} criado.", "success")
    return redirect(url_for("admin.admin_users"))


@bp.route("/usuarios/<int:user_id>")
def admin_user_detail(user_id):
    user = User.query.get_or_404(user_id)
    invites = (
        Invite.query.filter_by(user_id=user.id)
        .order_by(Invite.created_at.desc())
        .limit(500)
        .all()
    )
    return render_template("admin_user_detail.html", title=f"Admin — {user.username}", u=user, invites=invites)


@bp.route("/usuarios/<int:user_id>/ban", methods=["POST"])
def toggle_ban(user_id):
    user = User.query.get_or_404(user_id)
    if user.id == current_user.id:
        flash("Você não pode banir a si mesmo.", "error")
        return redirect(url_for("admin.admin_users"))
    user.is_banned = not user.is_banned
    db.session.commit()
    flash(f"Usuário {user.username} {'banido' if user.is_banned else 'desbanido'}.", "success")
    return redirect(url_for("admin.admin_users"))


@bp.route("/usuarios/<int:user_id>/admin", methods=["POST"])
def toggle_admin(user_id):
    user = User.query.get_or_404(user_id)
    if user.id == current_user.id:
        flash("Você não pode alterar seu próprio nível de admin.", "error")
        return redirect(url_for("admin.admin_users"))
    user.is_admin = not user.is_admin
    db.session.commit()
    flash(f"Usuário {user.username} agora {'é' if user.is_admin else 'não é mais'} admin.", "success")
    return redirect(url_for("admin.admin_users"))


@bp.route("/usuarios/<int:user_id>/resetar-senha", methods=["POST"])
def reset_password(user_id):
    user = User.query.get_or_404(user_id)
    new_password = secrets.token_urlsafe(8)
    user.set_password(new_password)
    db.session.commit()
    flash(f"Nova senha de {user.username}: {new_password}", "success")
    return redirect(url_for("admin.admin_user_detail", user_id=user.id))
