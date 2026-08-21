"""Client for the disposable-mailbox platform at mail.verifywaba.store (own "Inbox Livre"
instance). No authentication on that API — anyone who knows an address can read its inbox, so
addresses are treated as secrets: generated randomly, never guessable, one per Business Manager.
"""
import secrets
import time

import requests

from ..config import Config

# 32 symbols, no confusables (no 'l'/'1', no 'o'/'0') so an address is easy to read back if needed.
_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789"
_PREFIX_RE_LEN = (3, 32)  # server pattern: ^[a-z0-9][a-z0-9._-]{2,31}$


class TempMailError(Exception):
    pass


def random_prefix() -> str:
    # "bm" + 12 symbols = 14 chars; comfortably inside the 3..32 length rule.
    # 32**12 ~= 1.15e18 possible addresses per domain.
    return "bm" + "".join(secrets.choice(_ALPHABET) for _ in range(12))


def create_mailbox(prefix: str | None = None) -> str:
    """Create a mailbox on the temp-mail platform and return its full address.
    Retries a handful of times on prefix collisions with a fresh random prefix.
    Raises TempMailError on any non-recoverable failure (network, 429 after one retry, etc).
    """
    base = Config.TEMPMAIL_BASE_URL.rstrip("/")
    domain = Config.TEMPMAIL_DOMAIN
    timeout = Config.TEMPMAIL_TIMEOUT

    last_error = "erro desconhecido"
    retried_429 = False

    for _attempt in range(3):
        use_prefix = prefix or random_prefix()
        try:
            resp = requests.post(
                f"{base}/api/mailbox",
                json={"prefix": use_prefix, "domain": domain},
                timeout=timeout,
            )
        except requests.RequestException as e:
            raise TempMailError(f"falha ao contatar o servidor de e-mail: {e}") from e

        if resp.status_code == 429:
            if retried_429:
                raise TempMailError("limite de criação de e-mails atingido, tente em instantes")
            retried_429 = True
            retry_after = resp.headers.get("Retry-After")
            try:
                time.sleep(min(float(retry_after), 5))
            except (TypeError, ValueError):
                time.sleep(1)
            continue

        try:
            body = resp.json()
        except ValueError:
            body = {}

        if resp.ok and body.get("success"):
            data = body.get("data") or {}
            address = (
                data.get("address")
                or (data.get("mailbox") or {}).get("address")
                or f"{use_prefix}@{domain}"
            )
            return address

        last_error = body.get("message") or f"HTTP {resp.status_code}"
        if prefix:
            # caller asked for a specific prefix — collision or invalid, don't retry with a random one
            break

    raise TempMailError(f"falha ao criar caixa de e-mail: {last_error}")


def inbox_url(address: str | None) -> str | None:
    """Web-UI link for an address, or None when it doesn't belong to our temp-mail domain
    (e.g. a legacy Gmail address stored before this feature existed)."""
    if not address or "@" not in address:
        return None
    domain = address.rsplit("@", 1)[-1].lower()
    if domain != Config.TEMPMAIL_DOMAIN.lower():
        return None
    base = Config.TEMPMAIL_BASE_URL.rstrip("/")
    return f"{base}/inbox/{address}"
