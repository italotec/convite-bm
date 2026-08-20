"""Builds a per-user ZIP of extension/ (the "Convite BM" browser extension) with the current
user's API key, base URL and invite email baked in, so it authenticates and knows who to invite
on install with no manual config. Mirrors I:\\Manager Lite\\app\\routes\\extension_bp.py.
"""
import io
import json
import os
import zipfile

from flask import Blueprint, request, send_file, flash, redirect, url_for
from flask_login import login_required, current_user

from ..config import Config

bp = Blueprint("extension", __name__, url_prefix="/extension")

_EXTENSION_DIR = os.path.join(os.getcwd(), "extension")
_HOST_PLACEHOLDER = "__CONVITE_BASE_URL__/*"


@bp.route("/download")
@login_required
def download():
    if not current_user.invite_email:
        flash("Defina seu e-mail de convite antes de baixar a extensão.", "error")
        return redirect(url_for("account.account_page"))

    base_url = (Config.CONVITE_BASE_URL or request.host_url).rstrip("/")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _dirs, files in os.walk(_EXTENSION_DIR):
            for fn in files:
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, _EXTENSION_DIR).replace(os.sep, "/")
                if rel in ("config.js", "manifest.json"):
                    continue
                zf.write(full, rel)

        # `self`, not `window` — this file is loaded via importScripts() inside the extension's
        # service worker (background.js), which has no `window` global.
        config_js = (
            "self.__CB_CONFIG__ = {\n"
            f"  apiKey: {json.dumps(current_user.api_key or '')},\n"
            f"  baseUrl: {json.dumps(base_url)},\n"
            f"  email: {json.dumps(current_user.invite_email or '')}\n"
            "};\n"
        )
        zf.writestr("config.js", config_js)

        with open(os.path.join(_EXTENSION_DIR, "manifest.json"), encoding="utf-8") as f:
            manifest = json.load(f)
        manifest["host_permissions"] = [
            f"{base_url}/*" if h == _HOST_PLACEHOLDER else h
            for h in manifest.get("host_permissions", [])
        ]
        zf.writestr("manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False))

    buf.seek(0)
    fn = f"convite-bm-{current_user.username}.zip"
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=fn)
