import re

from flask import Blueprint, render_template, request, redirect, url_for, flash
from flask_login import login_required, current_user

from .. import db

bp = Blueprint("account", __name__, url_prefix="/conta")

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@bp.route("")
@login_required
def account_page():
    return render_template("account.html", title="Minha Conta")


@bp.route("/email", methods=["POST"])
@login_required
def save_email():
    email = (request.form.get("invite_email") or "").strip().lower()
    if not email or not _EMAIL_RE.match(email):
        flash("Informe um e-mail válido.", "error")
        return redirect(url_for("account.account_page"))

    current_user.invite_email = email
    db.session.commit()
    flash("E-mail salvo. Agora você pode baixar a extensão personalizada.", "success")
    return redirect(url_for("account.account_page"))


@bp.route("/auto", methods=["POST"])
@login_required
def save_auto():
    current_user.auto_invite_enabled = request.form.get("auto_invite_enabled") == "on"
    try:
        delay = int(request.form.get("invite_delay_ms") or 4000)
    except ValueError:
        delay = 4000
    current_user.invite_delay_ms = max(1000, min(delay, 60000))
    db.session.commit()
    flash("Preferências de envio salvas.", "success")
    return redirect(url_for("account.account_page"))


@bp.route("/rotate-key", methods=["POST"])
@login_required
def rotate_key():
    current_user.generate_api_key()
    db.session.commit()
    flash("Chave de API renovada. Baixe a extensão novamente para usar a nova chave.", "success")
    return redirect(url_for("account.account_page"))
