#!/usr/bin/env python3
"""portal.py — the docs.ace dashboard, rendered via the shared `card_grid` module
(design-web/dashboard-table-builder/scripts/card_grid.py). docs.ace is consumer #1.

Owns only: the docs.ace-specific spec (hero, facets incl. `kind` type-filter + `type`
section-filter, sorts, the doc→card mapping, the Share/Revoke/Delete actions) + the
per-doc-action wiring script. The module owns CSS/JS/theme/security.

Search is server-side (FTS5 body search): the module's live-search hits /api/search,
which returns rendered card HTML (module.render_cards).
"""
from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, "/Users/alexgierczyk/.hermes/skills-shared/design-web/dashboard-table-builder/scripts")
import card_grid  # noqa: E402


def _ago(ts: int) -> str:
    if not ts:
        return ""
    s = int(time.time()) - ts
    if s < 3600:
        return f"{s//60}m ago"
    if s < 86400:
        return f"{s//3600}h ago"
    return f"{s//86400}d ago"


# The per-doc-action script (Share/Revoke/Delete). Fixed bytes → its own CSP hash.
ACTIONS_JS = r"""
(function(){
  "use strict";
  function post(url,body){return fetch(url,{method:'POST',
    headers:{'Content-Type':'application/json','X-Docs-Ace-CSRF':'1'},
    body:JSON.stringify(body)}).then(function(r){return r.ok?r.json():Promise.reject(r.status);});}
  document.addEventListener('card-action',function(e){
    var d=e.detail, slug=d.id, act=d.act, b=d.btn;
    if(act==='delete'&&!confirm('Delete '+slug+'? (soft-delete)'))return;
    if(act==='revoke'&&!confirm('Revoke the public here.now share for '+slug+'?'))return;
    if(b)b.disabled=true;
    post('/api/doc/'+act,{slug:slug}).then(function(j){
      if(act==='share'&&j.url){if(navigator.clipboard)navigator.clipboard.writeText(j.url);window.open(j.url,'_blank');}
      location.reload();
    }).catch(function(c){if(b)b.disabled=false;alert(act+' failed ('+c+')');});
  });
})();
"""


def _actions_sha256() -> str:
    import base64, hashlib
    return base64.b64encode(hashlib.sha256(ACTIONS_JS.encode()).digest()).decode()

# the tiny html.js-toggle inline the module appends (must be hashed too)
_TOGGLE_JS = "document.documentElement.className+=' js';var c=document.querySelector('.controls');if(c)c.classList.add('js');"


def portal_csp() -> str:
    import base64, hashlib
    def h(s):
        return "'sha256-" + base64.b64encode(hashlib.sha256(s.encode()).digest()).decode() + "'"
    hashes = " ".join([
        f"'sha256-{card_grid.grid_js_sha256()}'",
        h(ACTIONS_JS),
        h(card_grid.TOGGLE_INLINE_JS),
        h(card_grid.endpoint_inline_js("/api/search")),
    ])
    return ("default-src 'none'; "
            f"script-src {hashes}; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com data:; "
            "img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")


def _doc_to_card(d: dict) -> dict:
    slug = d["slug"]
    kind = d.get("kind", "html")
    meta = f"{slug} · {_ago(d.get('updated'))}"
    badges = [{"text": "shared"}] if d.get("herenow_slug") else []
    actions = [{"act": "share", "label": "Re-share" if d.get("herenow_slug") else "Share"}]
    if d.get("herenow_slug"):
        actions.append({"act": "revoke", "label": "Revoke share"})
    actions.append({"act": "delete", "label": "Delete", "danger": True})
    return {
        "id": slug, "title": d.get("title") or slug, "href": f"https://{slug}.docs.ace/",
        "eyebrow": d.get("type", ""), "kind": kind, "badges": badges, "meta": meta,
        "facets": {"type": d.get("type", ""), "kind": kind},
        "sort": {"updated": d.get("updated", 0), "title": (d.get("title") or slug).lower()},
        "search": f"{d.get('type','')} {kind}",
        "actions": actions,
    }


def render_cards_only(docs: list[dict]) -> str:
    """Cards HTML for the /api/search live-search response."""
    return card_grid.render_cards([_doc_to_card(d) for d in docs])


def render_portal() -> str:
    try:
        import docs_index
        docs = docs_index.list_docs()
    except Exception:
        docs = []
    spec = {
        "title": "docs.ace", "theme": "noir", "eyebrow": "Local · here.now",
        "hero": "Everything we <em>made</em>, in one place.",
        "subtitle": "Briefs, docs & reports — searchable, private, yours.",
        "search_placeholder": "Search titles + body text…",
        "search_endpoint": "/api/search",
        "count_noun": "doc",
        "facets": [
            {"id": "kind", "label": "All types", "from_cards": True},
            {"id": "type", "label": "All sections", "from_cards": True},
        ],
        "sorts": [
            {"id": "updated", "label": "Newest", "default": True, "dir": "desc"},
            {"id": "title", "label": "Title A–Z", "dir": "asc"},
        ],
        "cards": [_doc_to_card(d) for d in docs],
    }
    page = card_grid.render_card_grid(spec)
    # inject the docs.ace action-wiring script (before </body>)
    page = page.replace("</body>", f"<script>{ACTIONS_JS}</script></body>", 1)
    return page
