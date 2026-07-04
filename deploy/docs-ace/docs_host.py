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

import html
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(os.environ.get("DOCS_HOST_PORT", "8790"))
ROOT = Path(os.environ.get("DOCS_ROOT", os.path.expanduser("~/.hermes/var/docs-portal/docroot")))

# I1 Origin/Host shape check (v1.3 anchored suffix+shape — NOT endswith).
# host is a single DNS label + ".docs.ace" (the apex "docs.ace" is the portal, handled separately).
SLUG_HOST_RE = re.compile(r"^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.docs\.ace$")
SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")

# CSP: Phase 1 pages carry no script. img/style allowances mirror I1x so briefs (Phase 2+) render.
# The 'sha256-<buttonjs>' script-src source is injected in Phase 3 when buttons ship.
CSP = ("default-src 'none'; script-src 'none'; "
       "style-src 'self' 'unsafe-inline'; "
       "img-src 'self' https://pbs.twimg.com https://*.twimg.com data:; "
       "font-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")


def _host_of(handler: BaseHTTPRequestHandler) -> str:
    h = handler.headers.get("Host", "") or ""
    return h.split(":")[0].strip().lower()


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

    def _send(self, code: int, body: bytes, ctype: str = "text/html; charset=utf-8", extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _404(self, msg="Not found"):
        self._send(404, f"<!doctype html><title>404</title><h1>404</h1><p>{html.escape(msg)}</p>".encode())

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        host = _host_of(self)
        path = self.path.split("?")[0]

        # health (any host)
        if path == "/healthz":
            self._send(200, b'{"ok":true,"service":"docs-host"}', "application/json")
            return

        # apex portal (docs.ace) — Phase 4 builds the real portal; Phase 1 stub.
        if host in ("docs.ace", "docs", ""):
            self._send(200, b"<!doctype html><title>docs.ace</title><h1>docs.ace</h1>"
                            b"<p>portal coming in Phase 4</p>")
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
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    sys.stderr.write(f"[docs-host] listening on 127.0.0.1:{PORT}, root={ROOT}\n")
    srv.serve_forever()


if __name__ == "__main__":
    main()
