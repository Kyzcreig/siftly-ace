#!/usr/bin/env python3
"""docs-host — the docs.ace local here.now clone host service.

Phase 1 scope: serve per-doc static pages by Host header (<slug>.docs.ace → the doc's
index.html) + a health endpoint. Phases 3/4/5 add /api/x/*, the portal, and doc actions.

Design (PRD-docs-ace-local-hosting v1.3):
- ONE process, two route groups (OQ2): the per-doc host (*.docs.ace) and the portal (docs.ace).
- Binds 127.0.0.1 + LAN + tailnet only (I1d) — never 0.0.0.0-public is handled by Caddy binding
  192.168.1.18; this service listens on 127.0.0.1 and Caddy reverse-proxies to it.
- Static, self-contained pages (I4). CSP header on every response (I1x) — the sha256 of the
  button JS is added in Phase 3; Phase-1 pages have no script so default-src 'none' + the
  media/style allowances is safe.
- Webroot layout: DOCROOT/<type>/<slug>/index.html  (type ∈ briefs|prds|reports|docs...)
  The host resolves a slug by scanning DOCROOT for a dir named <slug> (the slug is globally
  unique across types by construction — D-11).

Config via env:
  DOCS_HOST_PORT   (default 8790)
  DOCS_ROOT        (default ~/.hermes/var/docs-portal/docroot)
  DOCS_INDEX_DB    (default ~/.hermes/var/docs-portal/index.db)  [used Phase 4+]
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import x_token  # noqa: E402
except Exception:  # pragma: no cover
    x_token = None
try:
    from portal import render_portal, portal_csp  # noqa: E402
except Exception:  # pragma: no cover
    render_portal = None
    portal_csp = None

PORT = int(os.environ.get("DOCS_HOST_PORT", "8790"))
ROOT = Path(os.environ.get("DOCS_ROOT", os.path.expanduser("~/.hermes/var/docs-portal/docroot")))

# I1 Origin/Host shape check (v1.3 ANCHORED suffix+shape — NOT endswith, which
# 'evil-docs.ace.attacker.com' would pass). host = one DNS label + ".docs.ace".
SLUG_HOST_RE = re.compile(r"^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.docs\.ace$")
SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
# Origin must be https://<label>.docs.ace OR https://docs.ace (apex portal), NO port/path.
ORIGIN_RE = re.compile(r"^https://(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)?docs\.ace$")
# Host for an ACTION request: a slug host (button) or the apex (portal action).
ACTION_HOST_RE = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)?docs\.ace$")
TWEET_ID_RE = re.compile(r"^\d{5,25}$")
CSRF_HEADER = "X-Docs-Ace-CSRF"

# Per-device rate limit (RC4): <=10 actions / 60s / device.
RATE_MAX = 10
RATE_WINDOW = 60.0
_rate_lock = threading.Lock()
_rate: dict[str, list[float]] = {}

# CSP (I1x): script-src pins the sha256 of the fixed inline button JS (assets/x-buttons.js).
# A stored-XSS injected <script> (no matching hash) is blocked. img/style allowances keep
# tweet media + house theme rendering. If x-buttons.js changes, recompute BUTTON_JS_SHA256.
BUTTON_JS_SHA256 = "a3cP3BZk1M5TwAg8g+fHhQDrbSvpV6vxU/nVkDnJwpo="
CSP = ("default-src 'none'; "
       f"script-src 'sha256-{BUTTON_JS_SHA256}'; "
       "style-src 'self' 'unsafe-inline'; "
       "img-src 'self' https://pbs.twimg.com https://*.twimg.com data:; "
       "font-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")


def _host_of(handler: BaseHTTPRequestHandler) -> str:
    h = handler.headers.get("Host", "") or ""
    return h.split(":")[0].strip().lower()


def _alert_writeback(detail: str):
    """I2(c): loud #alerts when X rotated the refresh token but write-back failed."""
    try:
        import subprocess
        notify = os.path.expanduser("~/.hermes/scripts/notify.py")
        msg = ("🚨 docs.ace X token write-back FAILED after rotation — the only valid refresh "
               f"token is in memory; a restart loses it. Re-seed from 1Password ASAP. detail: {detail[:200]}")
        subprocess.run(["python3", notify, "--send", msg, "--severity", "high"],
                       timeout=20, capture_output=True)
    except Exception as e:
        sys.stderr.write(f"[docs-host] alert failed: {e}\n")


def resolve_slug_dir(slug: str) -> Path | None:
    """Find DOCROOT/<type>/<slug>/ for a slug. Path-traversal-safe (slug is regex-gated)."""
    if not SLUG_RE.match(slug):
        return None
    for typedir in ROOT.iterdir() if ROOT.is_dir() else []:
        if not typedir.is_dir():
            continue
        cand = typedir / slug
        # resolve() + is_relative_to guards against any symlink/traversal escape
        try:
            rc = cand.resolve()
            if rc.is_dir() and rc.is_relative_to(ROOT.resolve()) and (rc / "index.html").is_file():
                return rc
        except (OSError, ValueError):
            continue
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "docs-ace/1.0"

    def _send(self, code: int, body: bytes, ctype: str = "text/html; charset=utf-8", extra: dict | None = None, csp: str | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Security-Policy", csp or CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _404(self, msg="Not found"):
        self._send(404, f"<!doctype html><title>404</title><h1>404</h1><p>{html.escape(msg)}</p>".encode())

    # ---- I1 authz gate (the trust boundary) ----
    def _origin_ok(self) -> bool:
        """v1.3 anchored Origin check. NOT endswith. Falls back to Referer origin."""
        origin = (self.headers.get("Origin") or "").strip()
        if not origin:
            ref = (self.headers.get("Referer") or "").strip()
            if ref:
                m = re.match(r"^(https://[^/]+)", ref)
                origin = m.group(1) if m else ""
        return bool(ORIGIN_RE.match(origin))

    def _host_ok(self) -> bool:
        return bool(SLUG_HOST_RE.match(_host_of(self)))

    def _device_id(self) -> str:
        """Per-device rate key (RC4): a device cookie, else the peer address."""
        cookie = self.headers.get("Cookie") or ""
        m = re.search(r"docsdev=([a-f0-9]{8,64})", cookie)
        if m:
            return m.group(1)
        return "peer:" + self.address_string()

    def _rate_ok(self, dev: str) -> bool:
        now = time.time()
        with _rate_lock:
            hist = [t for t in _rate.get(dev, []) if now - t < RATE_WINDOW]
            if len(hist) >= RATE_MAX:
                _rate[dev] = hist
                return False
            hist.append(now)
            _rate[dev] = hist
            return True

    def _json(self, code: int, obj: dict, extra: dict | None = None):
        self._send(code, json.dumps(obj).encode(), "application/json", extra)

    def do_OPTIONS(self):
        # CORS preflight (I1b). Only reflect ACAO/ACAH for an allowed docs.ace origin.
        origin = (self.headers.get("Origin") or "").strip()
        if ORIGIN_RE.match(origin):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", CSRF_HEADER + ", Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Vary", "Origin")
            self.end_headers()
        else:
            # WITHHOLD the ACAO/ACAH headers → the browser blocks the follow-up request.
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()

    def do_POST(self):
        path = self.path.split("?")[0]
        # ---- portal doc actions (Phase 5): share / revoke / delete ----
        dm = re.match(r"^/api/doc/(share|revoke|delete)$", path)
        if dm:
            action = dm.group(1)
            if not ACTION_HOST_RE.match(_host_of(self)):
                self._json(403, {"error": "bad host"}); return
            if not self._origin_ok():
                self._json(403, {"error": "bad origin"}); return
            if self.headers.get(CSRF_HEADER) != "1":
                self._json(403, {"error": "missing csrf marker"}); return
            try:
                n = int(self.headers.get("Content-Length") or "0")
                body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            except Exception:
                self._json(400, {"error": "bad body"}); return
            slug = str(body.get("slug", "")).strip()
            if not SLUG_RE.match(slug):
                self._json(400, {"error": "bad slug"}); return
            try:
                import doc_actions
                res = getattr(doc_actions, action)(slug)
            except Exception as e:
                self._json(502, {"error": str(e)[:120]}); return
            acao = self.headers.get("Origin", "")
            code = 200 if res.get("ok") else 400
            self._json(code, res, extra={"Access-Control-Allow-Origin": acao, "Vary": "Origin"})
            return

        m = re.match(r"^/api/x/(like|unlike|bookmark|unbookmark)$", path)
        if not m:
            self._json(404, {"error": "not found"})
            return
        action = m.group(1)
        # I1 gate, all must pass BEFORE any X call, else 403 zero-call.
        if not self._host_ok():
            self._json(403, {"error": "bad host"}); return
        if not self._origin_ok():
            self._json(403, {"error": "bad origin"}); return
        if self.headers.get(CSRF_HEADER) != "1":
            self._json(403, {"error": "missing csrf marker"}); return
        # body
        try:
            n = int(self.headers.get("Content-Length") or "0")
            raw = self.rfile.read(n) if n else b"{}"
            body = json.loads(raw or b"{}")
        except Exception:
            self._json(400, {"error": "bad body"}); return
        tid = str(body.get("tweet_id", "")).strip()
        if not TWEET_ID_RE.match(tid):
            self._json(400, {"error": "bad tweet_id"}); return
        dev = self._device_id()
        if not self._rate_ok(dev):
            self._json(429, {"error": "rate limited"}); return
        if x_token is None:
            self._json(503, {"error": "token module unavailable"}); return
        try:
            data = x_token.do_action(action, tid)
        except x_token.WriteBackError as e:
            sys.stderr.write(f"[docs-host] TOKEN WRITE-BACK FAILURE: {e}\n")
            _alert_writeback(str(e))
            self._json(500, {"error": "token write-back failed", "detail": "alerted"}); return
        except Exception as e:
            self._json(502, {"error": "x api error", "detail": str(e)[:120]}); return
        acao = self.headers.get("Origin", "")
        self._json(200, {"ok": True, "action": action, "tweet_id": tid, "data": data},
                   extra={"Access-Control-Allow-Origin": acao, "Vary": "Origin"})

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        host = _host_of(self)
        path = self.path.split("?")[0]

        # health (any host)
        if path == "/healthz":
            self._send(200, b'{"ok":true,"service":"docs-host"}', "application/json")
            return

        # apex portal (docs.ace) — cards + full-text search (Phase 4).
        if host in ("docs.ace", "docs", ""):
            # search endpoint (JSON): /api/search?q=...
            if path == "/api/search":
                q = ""
                if "?" in self.path:
                    from urllib.parse import parse_qs, urlparse
                    q = (parse_qs(urlparse(self.path).query).get("q") or [""])[0]
                try:
                    import docs_index
                    results = docs_index.search(q)
                except Exception as e:
                    self._json(500, {"error": str(e)[:100]}); return
                self._json(200, {"results": results})
                return
            if render_portal is None:
                self._send(503, b"portal unavailable")
                return
            self._send(200, render_portal().encode(), csp=(portal_csp() if portal_csp else None))
            return

        # per-doc host: <slug>.docs.ace
        m = SLUG_HOST_RE.match(host)
        if not m:
            self._404("unknown host")
            return
        slug = m.group(1)
        d = resolve_slug_dir(slug)
        if d is None:
            self._404(f"no doc for slug '{slug}'")
            return

        # serve the doc's assets (index.html at /, plus any sibling files it references)
        rel = path.lstrip("/") or "index.html"
        if rel.endswith("/"):
            rel += "index.html"
        target = (d / rel)
        try:
            tr = target.resolve()
            if not (tr.is_file() and tr.is_relative_to(d.resolve())):
                self._404("asset not found")
                return
        except (OSError, ValueError):
            self._404("bad path")
            return
        ctype = "text/html; charset=utf-8"
        if tr.suffix in (".js",): ctype = "text/javascript; charset=utf-8"
        elif tr.suffix in (".css",): ctype = "text/css; charset=utf-8"
        elif tr.suffix in (".json",): ctype = "application/json"
        elif tr.suffix in (".png",): ctype = "image/png"
        elif tr.suffix in (".jpg", ".jpeg"): ctype = "image/jpeg"
        elif tr.suffix in (".svg",): ctype = "image/svg+xml"
        elif tr.suffix in (".webp",): ctype = "image/webp"
        self._send(200, tr.read_bytes(), ctype)

    def log_message(self, fmt, *args):
        sys.stderr.write("[docs-host] %s - %s\n" % (self.address_string(), fmt % args))


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    # RC3 launch-contract gate: assert a VALID token before binding (not mere presence),
    # so a stale-but-present token doesn't serve 403s all day. Non-fatal warn if x_token
    # missing (Phase-1 pages still serve); the button endpoint returns 503 until seeded.
    if x_token is not None:
        try:
            if x_token.startup_check():
                sys.stderr.write("[docs-host] token startup-check: VALID\n")
            else:
                sys.stderr.write("[docs-host] WARNING: token startup-check FAILED — /api/x/* will 502 until re-seeded\n")
                _alert_writeback("startup token invalid/absent")
        except Exception as e:
            sys.stderr.write(f"[docs-host] token startup-check error: {e}\n")
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    sys.stderr.write(f"[docs-host] listening on 127.0.0.1:{PORT}, root={ROOT}\n")
    srv.serve_forever()


if __name__ == "__main__":
    main()
