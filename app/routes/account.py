from flask import Blueprint, render_template, request, redirect, url_for, flash
from flask_login import login_required, current_user

from .. import db

bp = Blueprint("account", __name__, url_prefix="/conta")


@bp.route("")
@login_required
def account_page():
    return render_template("account.html", title="Minha Conta")


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
