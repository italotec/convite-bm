---
name: deploy-vps
description: Commit local changes, push to origin/main on GitHub, then redeploy Convite BM on the production VPS via the ssh-manager MCP (git pull + restart the convite.service systemd unit). Use when the user says "deploy", "deploy to vps", "update vps", "push and deploy", or anything equivalent.
---

# Deploy Convite BM to the VPS

Two-stage deploy: (A) push to GitHub, (B) pull + restart on the VPS. This is a
**redeploy-only** skill — it assumes the VPS is already provisioned (venv, systemd unit,
nginx + SSL already in place). It does not re-provision from scratch.

## Config (source of truth)

| Field | Value |
|---|---|
| GitHub remote | `https://github.com/italotec/convite-bm.git` (owner=`italotec`, repo=`convite-bm`, **public**) |
| SSH alias | `myvps` (169.58.142.85, user `root` — no sudo password needed; see `SSH_SERVER_MYVPS_*` in local `.env`) |
| Remote path | `/var/www/convite` (owned by `root`) |
| Python | `/var/www/convite/venv` (created with system `python3`, currently 3.12) |
| App port | `5020` (loopback+public; nginx reverse-proxies `convite.verifywaba.store`) |
| Process manager | **systemd**, unit `convite.service` (`Type=simple`, `User=root`, `Restart=always`) — NOT screen |
| Public URL | `https://convite.verifywaba.store` (SSL via certbot, auto-renews) |
| nginx site | `/etc/nginx/sites-available/convite` — no upload endpoints, no websocket, plain reverse proxy |
| Prod `.env` | `/var/www/convite/.env` — `SECRET_KEY` + `CONVITE_BASE_URL=https://convite.verifywaba.store`, loaded via `python-dotenv` in `run.py`. **Never** let `SECRET_KEY` change once set (would invalidate every session cookie) |

The VPS also hosts `deployer` (:5004), `manager` (:5003) and `manager-lite` (:5012). Never reload
nginx or touch `/etc/nginx/conf.d/upload-tuning.conf` (shared global upload tuning) without
`nginx -t` first.

## Pre-flight (always)

1. `git status` locally; inspect every modified/untracked file.
2. **Refuse to commit secrets.** Grep staged content for: `github_pat_`, `ghp_`, `gho_`, `ghs_`;
   `Bearer ` + long opaque strings; `SSH_SERVER_*PASSWORD`; `SECRET_KEY=` with a real
   (non-placeholder) value; `password = "` / `password: "` with non-empty values.
3. Files that must never be committed (already in `.gitignore`): `.mcp.json` (GitHub PAT),
   `.env`/`*.env`, `instance/` (SQLite DB), `*.har` (huge Facebook session captures), `.venv/`.
4. Confirm ambiguous files with the user before staging.

## Phase A — GitHub push

1. Stage allowed files **explicitly by name** — never `git add .`.
2. Commit with a message explaining the *why*.
3. `git push origin main`. Auth is handled by the Windows Git Credential Manager (already primed
   for `italotec`) — do **not** embed the `.mcp.json` PAT in the remote URL, it's a
   Copilot-API-scoped token and gets rejected (`403`) for raw git-over-HTTPS pushes.
4. If push is rejected (non-fast-forward): `git pull --rebase origin main`, then re-push.
5. Verify: `mcp__github__get_commit(owner="italotec", repo="convite-bm", sha="main")`, compare its
   `sha` to local `git rev-parse HEAD`.

## Phase B — VPS redeploy

All remote commands go through `mcp__ssh-manager__ssh_execute`. The session logs in as `root`, so
nothing here needs `ssh_execute_sudo` — `systemctl`, `/etc/nginx` and `/etc/systemd` are all
writable directly.

**Quoting pitfall:** every remote command here is wrapped as `bash -c "..."` and sent as one
string. If that string itself contains nginx/systemd-style `$variables` or a `$(...)` command
substitution, bash evaluates them **before** the inner command ever runs. Rule: never use `$(...)`
in these commands — run the sub-step separately, read its plain output yourself, then splice the
literal value into the next command. Writing config files with literal `$` (nginx `$host`) needs a
heredoc with a **quoted** delimiter (`<<'EOF'`) — escaping with `\$` produces a broken config, not
a literal `$`.

- **B1 — Pull latest code:**
  ```
  ssh_execute(server="myvps", command='bash -c "cd /var/www/convite && git pull origin main"')
  ```
  Repo is public, no auth needed. On `Your local changes would be overwritten` (shouldn't normally
  happen — nothing else runs `git` on the VPS): `git stash push -m pre-deploy-stash && git pull
  origin main && git stash pop`, then stop and show the user any conflict markers.

- **B2 — Install/upgrade deps** into the venv:
  ```
  ssh_execute(server="myvps", command='bash -c "cd /var/www/convite && venv/bin/pip install -q -r requirements.txt"')
  ```

- **B3 — Smoke-test import** before restarting (catches syntax/import errors while the old
  process is still serving traffic):
  ```
  ssh_execute(server="myvps", command='bash -c "cd /var/www/convite && venv/bin/python3 -c \\"from dotenv import load_dotenv; load_dotenv(); from app import create_app; create_app()\\""')
  ```
  Abort the deploy and report the traceback if this fails — do not restart the service.

- **B4 — Restart the service:**
  ```
  ssh_execute(server="myvps", command='bash -c "systemctl restart convite.service"')
  ```

- **B5 — Verify** (separate call, after a short pause):
  ```
  ssh_execute(server="myvps", command='bash -c "sleep 2 && systemctl is-active convite.service && ss -tlnp | grep 5020 && curl -s -o /dev/null -w \\"%{http_code}\\" https://convite.verifywaba.store/login"')
  ```
  Expect `active`, a `python3` LISTEN row on `0.0.0.0:5020`, and `200`. If the service failed:
  `ssh_execute(command='bash -c "journalctl -u convite.service -n 60 --no-pager"')`.

## Extension note

The zip served at `/extension/download` is generated on the fly from `extension/` at request
time — a deploy that changes `extension/*.js` takes effect immediately for the *next* download,
but every user who already downloaded a copy is running the old one until they re-download and
reload it in `chrome://extensions`. There is no push-update mechanism; if a fix is
behavior-critical (e.g. a broken doc_id), tell the user to have everyone re-download.

## End-of-deploy summary to user

Report: local commit SHA, GitHub commit URL
(`https://github.com/italotec/convite-bm/commit/<sha>`), VPS `git rev-parse HEAD` (must match),
`systemctl is-active convite.service` result, and the public URL
(`https://convite.verifywaba.store`) confirmed reachable.

## Notes

- No Celery, no websocket — this app is a plain Flask app with SQLite (WAL mode), same pattern as
  Deployer Funis minus the background job/deploy machinery.
- `systemctl restart` briefly drops in-flight requests exactly like a crash would — there is no
  background job state to worry about (unlike Deployer Funis' funnel deploys), so restarting mid-day
  is always safe.
- `SECRET_KEY` in `/var/www/convite/.env` must never change once set — doing so invalidates every
  logged-in session's cookie and forces every user to log in again (data itself is unaffected).
