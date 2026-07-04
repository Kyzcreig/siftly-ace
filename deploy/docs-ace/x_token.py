#!/usr/bin/env python3
"""x_token.py — scoped-token manager + X API caller for the docs.ace button endpoint.

Implements PRD v1.3 I2 (rotating refresh token, persisted-and-verified BEFORE serving,
under a cross-process flock) and I5 (closed verb allow-list; the token itself is scope-limited
to like/bookmark — proven POST→403).

- SoT = a local 0600 file mirror (I2 hot path); 1Password is the seed/backup.
- Refresh is serialized behind a cross-process flock so a concurrent double-401 rotates ONCE.
- On refresh: persist-and-VERIFY the new tokens to the mirror BEFORE returning them (atomic
  temp+rename). On write-back failure after X rotated → raise loud (the caller alerts).
- do_action() runs ONLY {like,unlike,bookmark,unbookmark} against the X v2 user endpoints.
"""
from __future__ import annotations

import fcntl
import json
import os
import time
import urllib.parse
import urllib.request
import urllib.error

MIRROR = os.environ.get("DOCS_X_TOKEN_MIRROR", os.path.expanduser("~/.hermes/state/docs-ace-x-token.json"))
LOCKFILE = MIRROR + ".lock"
X_USER_ID = os.environ.get("DOCS_X_USER_ID", "56282605")  # angalexg

# I5 closed allow-list: action -> (http_method, path_template). NEVER post/delete-tweet/DM/follow.
ACTIONS = {
    "like":       ("POST",   f"/2/users/{X_USER_ID}/likes"),
    "unlike":     ("DELETE", f"/2/users/{X_USER_ID}/likes/{{tid}}"),
    "bookmark":   ("POST",   f"/2/users/{X_USER_ID}/bookmarks"),
    "unbookmark": ("DELETE", f"/2/users/{X_USER_ID}/bookmarks/{{tid}}"),
}


class TokenError(Exception):
    pass


class WriteBackError(Exception):
    """Raised when X rotated the refresh token but we failed to persist it (loud-alert case)."""


def _load() -> dict:
    with open(MIRROR) as f:
        return json.load(f)


def _atomic_write(d: dict):
    tmp = MIRROR + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, json.dumps(d).encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, MIRROR)  # atomic


def _refresh_locked() -> dict:
    """Refresh the access token under a cross-process flock. Persist-and-verify before returning."""
    os.makedirs(os.path.dirname(LOCKFILE), exist_ok=True)
    lf = open(LOCKFILE, "w")
    try:
        fcntl.flock(lf, fcntl.LOCK_EX)  # cross-process serialize (I2a)
        # Re-read INSIDE the lock: another process may have already refreshed.
        d = _load()
        # Cheap liveness check — if the current access token still works, don't rotate.
        if _token_ok(d["access_token"]):
            return d
        # Perform the refresh (X rotates the refresh_token here).
        body = urllib.parse.urlencode({
            "grant_type": "refresh_token",
            "refresh_token": d["refresh_token"],
            "client_id": d["client_id"],
        }).encode()
        import base64
        basic = base64.b64encode(f'{d["client_id"]}:{d["client_secret"]}'.encode()).decode()
        req = urllib.request.Request(
            "https://api.x.com/2/oauth2/token", data=body,
            headers={"Authorization": f"Basic {basic}",
                     "Content-Type": "application/x-www-form-urlencoded"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                tok = json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            raise TokenError(f"refresh failed: HTTP {e.code} {e.read().decode()[:200]}")
        if "access_token" not in tok:
            raise TokenError(f"refresh returned no access_token: {json.dumps(tok)[:200]}")
        new = dict(d)
        new["access_token"] = tok["access_token"]
        if "refresh_token" in tok:  # X rotates it — persist the NEW one or we're locked out
            new["refresh_token"] = tok["refresh_token"]
        new["refreshed"] = int(time.time())
        # I2b: persist-and-VERIFY before returning/serving.
        try:
            _atomic_write(new)
            check = _load()
            if check.get("refresh_token") != new["refresh_token"] or check.get("access_token") != new["access_token"]:
                raise WriteBackError("post-write verify mismatch")
        except Exception as e:
            # X already rotated; the only valid refresh token is `new` in memory. Loud-fail (caller alerts).
            raise WriteBackError(f"token rotated but write-back failed: {e}; new_refresh_in_memory") from e
        return new
    finally:
        fcntl.flock(lf, fcntl.LOCK_UN)
        lf.close()


def _token_ok(access_token: str, timeout: float = 8.0) -> bool:
    """Cheap validity probe: GET /2/users/me."""
    req = urllib.request.Request("https://api.x.com/2/users/me",
                                 headers={"Authorization": f"Bearer {access_token}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status == 200
    except urllib.error.HTTPError:
        return False
    except Exception:
        return False


def startup_check() -> bool:
    """Launch-contract gate (RC3): the endpoint must hold a VALID token before binding."""
    try:
        d = _load()
    except Exception:
        return False
    if _token_ok(d["access_token"]):
        return True
    # try one refresh
    try:
        _refresh_locked()
        return True
    except Exception:
        return False


def do_action(action: str, tweet_id: str) -> dict:
    """Run a whitelisted like/bookmark action. Refresh-on-401 (once). Returns X's JSON data."""
    if action not in ACTIONS:
        raise TokenError(f"action not allowed: {action}")
    method, path_t = ACTIONS[action]
    d = _load()

    def _call(access_token: str):
        url = "https://api.x.com" + path_t.format(tid=tweet_id)
        data = None
        headers = {"Authorization": f"Bearer {access_token}"}
        if method == "POST":
            data = json.dumps({"tweet_id": tweet_id}).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode())

    try:
        status, jd = _call(d["access_token"])
        return jd.get("data", jd)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            d = _refresh_locked()  # rotate + persist
            status, jd = _call(d["access_token"])
            return jd.get("data", jd)
        raise TokenError(f"X API HTTP {e.code}: {e.read().decode()[:200]}")


if __name__ == "__main__":
    import sys
    if len(sys.argv) >= 2 and sys.argv[1] == "--check":
        print("startup token valid:", startup_check())
