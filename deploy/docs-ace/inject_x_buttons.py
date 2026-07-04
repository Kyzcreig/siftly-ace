#!/usr/bin/env python3
"""inject_x_buttons.py — post-render injector that adds like/bookmark buttons to X items
in a docs.ace brief (PRD v1.3 Phase 3).

For every <article class="tweet"> ... </article>, extract the PRIMARY tweet id from the
first x.com/<handle>/status/<id> link inside it (quote-tweets pin the primary), and inject
a button row calling the same-origin /api/x/* endpoint. Also inlines the fixed button JS
(assets/x-buttons.js) whose sha256 is pinned in the docs-host CSP.

Only runs for the SERVED copy (docs.ace) — the SHARE step strips these (I4). Idempotent.
"""
from __future__ import annotations

import html
import os
import re
import sys

ASSET = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "x-buttons.js")

BTN_CSS = """
<style id="x-btn-css">
.x-actions{display:flex;gap:10px;margin-top:8px}
.x-btn{cursor:pointer;background:none;border:1px solid #333;border-radius:16px;color:#8b98a5;
  font:13px system-ui;padding:4px 12px;display:inline-flex;align-items:center;gap:5px;transition:.15s}
.x-btn:hover{border-color:#1d9bf0;color:#1d9bf0}
.x-btn.x-active[data-x-action=like]{color:#f91880;border-color:#f91880}
.x-btn.x-active[data-x-action=bookmark]{color:#1d9bf0;border-color:#1d9bf0}
.x-btn:disabled{opacity:.5}
</style>"""

# first x.com|twitter.com/<handle>/status/<id> inside an article
STATUS_RE = re.compile(r"(?:x\.com|twitter\.com)/[A-Za-z0-9_]+/status/(\d{5,25})")
ARTICLE_RE = re.compile(r'(<article class="tweet">)(.*?)(</article>)', re.DOTALL)


def button_row(tid: str) -> str:
    t = html.escape(tid)
    return (f'<div class="x-actions" data-x-buttons>'
            f'<button class="x-btn" data-x-action="like" data-x-tid="{t}" '
            f'aria-label="Like on X">♥ Like</button>'
            f'<button class="x-btn" data-x-action="bookmark" data-x-tid="{t}" '
            f'aria-label="Bookmark on X">🔖 Bookmark</button></div>')


def inject(page: str) -> tuple[str, int]:
    if "data-x-buttons" in page:  # idempotent
        return page, 0
    count = 0

    def _repl(m):
        nonlocal count
        open_tag, inner, close_tag = m.group(1), m.group(2), m.group(3)
        sm = STATUS_RE.search(inner)
        if not sm:
            return m.group(0)
        tid = sm.group(1)
        count += 1
        return open_tag + inner + button_row(tid) + close_tag

    page = ARTICLE_RE.sub(_repl, page)
    if count == 0:
        return page, 0

    # inline the CSS + button JS before </body> (JS hash is CSP-pinned)
    try:
        js = open(ASSET).read()
    except Exception:
        js = ""
    inject_block = BTN_CSS + f'\n<script>{js}</script>\n'
    if "</body>" in page:
        page = page.replace("</body>", inject_block + "</body>", 1)
    else:
        page = page + inject_block
    return page, count


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="infile", required=True)
    ap.add_argument("--out", dest="outfile", default=None)
    a = ap.parse_args()
    page = open(a.infile, encoding="utf-8").read()
    out, n = inject(page)
    dest = a.outfile or a.infile
    open(dest, "w", encoding="utf-8").write(out)
    sys.stderr.write(f"[inject_x_buttons] injected {n} button rows -> {dest}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
