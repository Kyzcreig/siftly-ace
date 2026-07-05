#!/usr/bin/env python3
"""card_grid.py — shared renderer for the fleet's SEARCHABLE CARD-GRID portals
(docs.ace, greenhouse.ace) — the sibling of dashboard-table-builder (which owns TABLE
dashboards: logs/crons/index).

One call:  render_card_grid(spec) -> str   (a full standalone HTML page).
You write a declarative spec (hero, facets, cards); the module owns the CSS, the
progressive-enhancement JS, the themes, and the security model.

SECURITY MODEL (inherited from the .ace generators — KEEP IT):
  - ALL dynamic text is html.escape'd before it reaches the file (helpers do this).
  - The enhancement JS reads card data FROM THE DOM at runtime (data-search,
    data-f-<facet>, data-sort-<key>). There is ZERO server-interpolated card data
    inside <script>, so there is no XSS surface there. Keep it that way.
  - A card field may be trusted HTML only via an explicit {"html": ...}; that HTML is
    the caller's responsibility (build it with esc() from this module).

CSP NOTE: the enhancement JS (GRID_JS) is FIXED (identical bytes for every render), so a
consumer that pins a CSP `script-src 'sha256-...'` can compute the hash ONCE via
grid_js_sha256() and it never drifts across renders. (docs.ace does exactly this.)

SPEC (contract):
  {
    "title": "docs.ace",                 # <title>
    "theme": "noir",                     # "noir" (luxe, default) | "github-dark"
    "eyebrow": "Local · here.now",       # gold kicker (optional)
    "hero": "Everything we <em>made</em>, in one place.",  # serif hero; one <em>…</em> ok
    "subtitle": "Briefs, docs & reports — searchable.",
    "search_placeholder": "Search…",
    "search_endpoint": "/api/search",    # optional: live search hits this ?q=…; else DOM-filter
    "count_noun": "doc",                 # "N docs"
    "facets": [                          # dropdown filters (client-side, DOM-driven)
       {"id": "kind", "label": "All types", "options": ["html","pdf","image","md"]},
       {"id": "type", "label": "All sections", "from_cards": True},  # options auto from cards
    ],
    "sorts": [                           # sort dropdown options (client-side)
       {"id": "updated", "label": "Newest", "default": True},
       {"id": "title",   "label": "Title A–Z"},
    ],
    "cards": [{
       "id": "…", "title": "Morning Digest — Jul 4", "href": "https://slug.docs.ace/",
       "eyebrow": "briefs",              # small gold label on the card (e.g. type)
       "badges": [{"text":"shared","kind":"1"}],   # pill badges
       "meta": "zephyr-trellis-38c9 · 3h ago",     # muted meta line
       "kind": "html",                   # a facet value (matches facet id "kind")
       "facets": {"type":"briefs"},      # per-facet values for filtering
       "sort": {"updated": 1783200000, "title": "morning digest"},  # per-sort keys
       "search": "extra haystack terms", # appended to the search haystack
       "actions": [                      # optional per-card action buttons
          {"act":"share","label":"Share"},
          {"act":"delete","label":"Delete","danger":True},
       ],
    }, ...],
  }
"""
from __future__ import annotations

import base64
import hashlib
import html as _html
from typing import Any


def esc(s: Any) -> str:
    return _html.escape(str(s if s is not None else ""))


# ---- themes (mirror dashboard-table-builder tokens) ----
_THEMES = {
    "noir": {
        "font": ("@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@"
                 "0,9..144,300;0,9..144,400;0,9..144,600;1,9..144,300&family=Inter+Tight:wght@400;500;600&display=swap');"),
        "vars": (":root{--bg:#0c0c0e;--panel:#141417;--border:#2e2e34;--fg:#ece8e1;--muted:#a49e93;"
                 "--accent:#d4ac68;--goldsoft:rgba(212,172,104,.15);--chip:#17171b;--chip-fg:#c4bdb0;"
                 "--dim:#6a665e;--b1:#d4ac68;--b1soft:rgba(212,172,104,.3);--danger:#e08a72;color-scheme:dark}"),
        "serif": '"Fraunces",Georgia,serif',
        "sans": '"Inter Tight",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
        "hero_weight": "300",
        "bggrad": "background-image:radial-gradient(ellipse 80% 50% at 50% -8%,rgba(212,172,104,.08),transparent 60%);",
        "title_serif": True,
        "csp_fonts": True,
    },
    "github-dark": {
        "font": "",
        "vars": (":root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--fg:#e6edf3;--muted:#8b949e;"
                 "--accent:#58a6ff;--goldsoft:rgba(88,166,255,.12);--chip:#21262d;--chip-fg:#adbac7;"
                 "--dim:#565c66;--b1:#58a6ff;--b1soft:rgba(88,166,255,.3);--danger:#f85149;color-scheme:dark}"),
        "serif": '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
        "sans": '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
        "hero_weight": "650",
        "bggrad": "",
        "title_serif": False,
        "csp_fonts": False,
    },
}


# ---- the FIXED enhancement JS (identical bytes every render → stable CSP hash) ----
# Reads all card data from DOM data-* attrs. search box + facet selects + sort select.
# If the page sets window.__CARD_SEARCH_ENDPOINT__, the search box hits it (live server
# search returning cards HTML); otherwise it DOM-filters the static cards.
GRID_JS = r"""
(function(){
  "use strict";
  var grid=document.getElementById('grid'), q=document.getElementById('q');
  var count=document.getElementById('count'), noun=grid?grid.getAttribute('data-noun')||'item':'item';
  var facets=[].slice.call(document.querySelectorAll('select[data-facet]'));
  var sortSel=document.getElementById('sort');
  function cards(){return [].slice.call(grid.querySelectorAll('.card'));}
  var orig=cards();
  function setCount(n){if(count)count.textContent=n+' '+noun+(n===1?'':'s');}
  function apply(){
    var term=(q&&q.value||'').trim().toLowerCase();
    var fv={};facets.forEach(function(s){if(s.value)fv[s.getAttribute('data-facet')]=s.value;});
    var shown=0;
    cards().forEach(function(c){
      var ok=true;
      if(term && (c.getAttribute('data-search')||'').indexOf(term)<0) ok=false;
      if(ok){for(var k in fv){if(c.getAttribute('data-f-'+k)!==fv[k]){ok=false;break;}}}
      c.hidden=!ok; if(ok)shown++;
    });
    setCount(shown);
  }
  function sortNow(){
    if(!sortSel)return;
    var key=sortSel.value, dir=sortSel.getAttribute('data-dir-'+key)||'desc';
    var arr=cards();
    arr.sort(function(a,b){
      var x=a.getAttribute('data-sort-'+key)||'', y=b.getAttribute('data-sort-'+key)||'';
      var nx=parseFloat(x), ny=parseFloat(y);
      if(!isNaN(nx)&&!isNaN(ny)){x=nx;y=ny;}
      if(x<y)return dir==='asc'?-1:1; if(x>y)return dir==='asc'?1:-1; return 0;
    });
    arr.forEach(function(c){grid.appendChild(c);});
  }
  var endpoint=window.__CARD_SEARCH_ENDPOINT__;
  var t;
  function run(){
    if(endpoint){
      clearTimeout(t);t=setTimeout(function(){
        fetch(endpoint+'?q='+encodeURIComponent(q?q.value:'')).then(function(r){return r.text();})
          .then(function(txt){grid.innerHTML=txt;orig=cards();sortNow();apply();});
      },160);
    } else { apply(); }
  }
  if(q)q.addEventListener('input',run);
  facets.forEach(function(s){s.addEventListener('change',apply);});
  if(sortSel)sortSel.addEventListener('change',function(){sortNow();apply();});
  // card action buttons (delegated): dispatch a CustomEvent the page handles.
  grid.addEventListener('click',function(e){
    var b=e.target.closest('[data-act]');if(!b)return;
    var card=b.closest('.card');
    document.dispatchEvent(new CustomEvent('card-action',{detail:{
      act:b.getAttribute('data-act'), id:card?card.getAttribute('data-id'):null, btn:b, card:card}}));
  });
  sortNow();
})();
"""


def grid_js_sha256() -> str:
    """base64 sha256 of the fixed GRID_JS, for a consumer's CSP script-src pin."""
    return base64.b64encode(hashlib.sha256(GRID_JS.encode()).digest()).decode()


def endpoint_inline_js(endpoint: str) -> str:
    """The exact inline JS bytes the module emits to set the live-search endpoint —
    so a consumer can hash it for CSP. Must match render_card_grid's emission exactly."""
    return f'window.__CARD_SEARCH_ENDPOINT__="{endpoint}";'


TOGGLE_INLINE_JS = ("document.documentElement.className+=' js';"
                    "var c=document.querySelector('.controls');if(c)c.classList.add('js');")


_CSS = """
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);font:15px/1.6 __SANS__;margin:0;padding:40px 28px 60px;__BGGRAD__ background-repeat:no-repeat}
.wrap{max-width:1140px;margin:0 auto}
.eyebrow{color:var(--accent);font-size:11px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;margin-bottom:10px}
h1{font-family:__SERIF__;font-weight:__HW__;font-size:40px;line-height:1.1;margin:0 0 6px;letter-spacing:-.01em}
h1 em{font-style:italic;color:var(--accent);font-weight:400}
.sub{color:var(--muted);font-size:14px;margin-bottom:26px}
.controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.searchwrap{position:relative;flex:1;min-width:220px;max-width:520px}
#q{width:100%;background:var(--panel);border:1px solid var(--border);border-radius:10px;color:var(--fg);font:15px __SANS__;padding:11px 15px 11px 38px}
#q::placeholder{color:var(--muted);opacity:.7}
#q:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--goldsoft)}
.searchwrap::before{content:"\\2315";position:absolute;left:13px;top:8px;color:var(--muted);font-size:17px}
select{background:var(--panel);border:1px solid var(--border);border-radius:10px;color:var(--fg);font:13px __SANS__;padding:10px 13px;cursor:pointer}
select:focus{outline:none;border-color:var(--accent)}
.controls.js{display:flex}.controls{display:none}
#count{color:var(--muted);font-size:12px;letter-spacing:.04em;text-transform:uppercase;margin-bottom:22px}
#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;align-items:stretch}
.card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:18px;transition:border-color .18s,transform .18s,box-shadow .18s;display:flex;flex-direction:column;height:100%}
.card[hidden]{display:none}
.card:hover{border-color:var(--b1soft);transform:translateY(-2px);box-shadow:0 8px 30px rgba(0,0,0,.4)}
.ctype{color:var(--accent);font-size:10px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;margin-bottom:9px}
.cicon{font-size:15px;margin-right:6px;letter-spacing:normal}
.badge{background:var(--goldsoft);color:var(--accent);border:1px solid var(--b1soft);border-radius:20px;padding:1px 9px;font-size:9px;letter-spacing:.08em;margin-left:8px;text-transform:uppercase}
.badge.ok{background:rgba(63,185,80,.14);color:#4ac26b;border-color:rgba(63,185,80,.3)}
.badge.warn{background:rgba(210,153,34,.14);color:#d8a629;border-color:rgba(210,153,34,.3)}
.badge.bad{background:rgba(248,81,73,.14);color:#f0776f;border-color:rgba(248,81,73,.3)}
.badge.neutral{background:transparent;color:var(--muted);border-color:var(--border)}
.ctitle{font-family:__TITLEFONT__;color:var(--fg);font-weight:__TITLEWT__;font-size:19px;line-height:1.25;text-decoration:none;display:block;margin-bottom:8px;letter-spacing:-.005em}
.ctitle:hover{color:var(--accent)}
.cmeta{color:var(--muted);font-size:12px;margin-bottom:14px;font-variant-numeric:tabular-nums}
.cbody{color:var(--fg);opacity:.82;font-size:13.5px;line-height:1.5;margin-bottom:14px}
.cacts{display:flex;gap:7px;flex-wrap:wrap;margin-top:auto}
.cacts button{cursor:pointer;background:var(--chip);border:1px solid var(--border);border-radius:8px;color:var(--chip-fg);font:12px __SANS__;padding:5px 12px;transition:border-color .15s,color .15s,background .15s}
.cacts button:hover{border-color:var(--accent);color:var(--accent);background:var(--goldsoft)}
.cacts button.danger:hover{border-color:var(--danger);color:var(--danger)}
.cacts button:disabled{opacity:.45;cursor:default}
.empty{color:var(--muted);font-family:__SERIF__;font-style:italic;font-size:17px;padding:20px 0}
.foot{color:var(--muted);font-size:12px;margin-top:32px;padding-top:18px;border-top:1px solid var(--border);line-height:1.6}
.foot a{color:var(--accent);text-decoration:none}
@media(max-width:640px){body{padding:28px 18px 40px}h1{font-size:32px}#grid{grid-template-columns:1fr}}
"""


def _kind(kind: str) -> str:
    return {"1": "kind1", "2": "kind2"}.get(str(kind), "kind1")


def render_card_html(c: dict) -> str:
    """Render ONE card. Public so a live-search endpoint can reuse it (returns the same markup)."""
    parts = []
    data = [f'data-id="{esc(c.get("id",""))}"']
    hay = " ".join(str(x) for x in [c.get("title",""), c.get("meta",""), c.get("eyebrow",""),
                                     c.get("body",""), c.get("search",""), c.get("kind","")]).lower()
    data.append(f'data-search="{esc(hay)}"')
    for fk, fv in (c.get("facets") or {}).items():
        data.append(f'data-f-{esc(fk)}="{esc(fv)}"')
    if c.get("kind"):
        data.append(f'data-f-kind="{esc(c["kind"])}"')
    for sk, sv in (c.get("sort") or {}).items():
        data.append(f'data-sort-{esc(sk)}="{esc(sv)}"')
    parts.append(f'<article class="card" {" ".join(data)}>')
    # eyebrow (+ optional icon) + badges. badge variant → colored pill (ok/warn/bad/neutral).
    eb = esc(c.get("eyebrow", "")) if c.get("eyebrow") else ""
    icon = f'<span class="cicon">{esc(c["icon"])}</span>' if c.get("icon") else ""
    def _badge(b):
        v = b.get("variant", "")
        cls = f"badge {esc(v)}" if v in ("ok", "warn", "bad", "neutral") else "badge"
        return f'<span class="{cls}">{esc(b["text"])}</span>'
    badges = "".join(_badge(b) for b in (c.get("badges") or []))
    if eb or badges or icon:
        parts.append(f'<div class="ctype">{icon}{eb} {badges}</div>')
    # title (linked)
    title = c.get("title") or c.get("id") or ""
    if c.get("href"):
        parts.append(f'<a class="ctitle" href="{esc(c["href"])}" target="_blank" rel="noopener">{esc(title)}</a>')
    else:
        parts.append(f'<div class="ctitle">{esc(title)}</div>')
    if c.get("meta"):
        parts.append(f'<div class="cmeta">{esc(c["meta"])}</div>')
    # body / summary line (optional)
    if c.get("body"):
        parts.append(f'<div class="cbody">{esc(c["body"])}</div>')
    # actions
    if c.get("actions"):
        btns = "".join(
            f'<button data-act="{esc(a["act"])}"{" class=danger" if a.get("danger") else ""}>{esc(a["label"])}</button>'
            for a in c["actions"])
        parts.append(f'<div class="cacts">{btns}</div>')
    parts.append('</article>')
    return "".join(parts)


def render_cards(cards: list[dict]) -> str:
    """Render just the cards (for a live-search endpoint response body)."""
    return "".join(render_card_html(c) for c in cards) or '<p class="empty">Nothing found.</p>'


def render_card_grid(spec: dict) -> str:
    theme = _THEMES.get(spec.get("theme", "noir"), _THEMES["noir"])
    cards = spec.get("cards", [])
    noun = spec.get("count_noun", "item")

    # controls: search + facet selects + sort select
    ctrls = ['<div class="searchwrap"><input id="q" type="search" placeholder="'
             + esc(spec.get("search_placeholder", "Search…")) + '" autocomplete="off"></div>']
    for f in (spec.get("facets") or []):
        opts = f.get("options")
        if f.get("from_cards"):
            seen = []
            for c in cards:
                v = (c.get("facets") or {}).get(f["id"]) or (c.get("kind") if f["id"] == "kind" else None)
                if v and v not in seen:
                    seen.append(v)
            opts = sorted(seen)
        o = f'<option value="">{esc(f.get("label","All"))}</option>'
        o += "".join(f'<option value="{esc(v)}">{esc(v)}</option>' for v in (opts or []))
        ctrls.append(f'<select data-facet="{esc(f["id"])}">{o}</select>')
    sorts = spec.get("sorts") or []
    if sorts:
        so = "".join(
            f'<option value="{esc(s["id"])}"{" selected" if s.get("default") else ""}>{esc(s.get("label", s["id"]))}</option>'
            for s in sorts)
        dirs = "".join(f' data-dir-{esc(s["id"])}="{esc(s.get("dir","desc"))}"' for s in sorts)
        ctrls.append(f'<select id="sort"{dirs}>{so}</select>')

    cards_html = render_cards(cards) if cards else '<p class="empty">Nothing here yet.</p>'
    endpoint_js = ""
    endpoint_inline = ""
    if spec.get("search_endpoint"):
        # JS string literal — NOT html-escaped (that corrupts the JS). The endpoint value is
        # caller-controlled config, not user data; still, restrict to a safe path charset.
        ep = spec["search_endpoint"]
        import re as _re
        if _re.match(r"^/[A-Za-z0-9_./-]*$", ep):
            endpoint_inline = f'window.__CARD_SEARCH_ENDPOINT__="{ep}";'
            endpoint_js = f"<script>{endpoint_inline}</script>"

    css = (_CSS
           .replace("__SANS__", theme["sans"])
           .replace("__SERIF__", theme["serif"])
           .replace("__HW__", theme["hero_weight"])
           .replace("__BGGRAD__", theme["bggrad"])
           .replace("__TITLEFONT__", theme["serif"] if theme["title_serif"] else theme["sans"])
           .replace("__TITLEWT__", "400" if theme["title_serif"] else "600"))
    n = len(cards)
    hero = _sanitize_hero(spec.get("hero", esc(spec.get("title", "Portal"))))
    eyebrow = f'<div class="eyebrow">{esc(spec["eyebrow"])}</div>' if spec.get("eyebrow") else ""
    sub = f'<div class="sub">{esc(spec["subtitle"])}</div>' if spec.get("subtitle") else ""
    # footer: trusted HTML (caller esc()'s dynamic bits), matches dashboard-table-builder convention.
    footer = f'<div class="foot">{spec["footer"]}</div>' if spec.get("footer") else ""
    # prebody (between hero and controls) / postbody (after grid) — raw trusted HTML the caller owns
    # (esc() any dynamic bits). Matches dashboard-table-builder's `prebody`. For KPI strips, ledgers,
    # side tables a pure card-grid doesn't model. docs.ace sets neither → its render is unaffected.
    prebody = spec.get("prebody", "") or ""
    postbody = spec.get("postbody", "") or ""
    # progressive enhancement: controls hidden until html.js; a tiny inline sets it (its own hash if CSP)
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(spec.get("title","Portal"))}</title>
<style>{theme["font"]}{theme["vars"]}{css}{spec.get("extra_css","")}</style></head><body>
<div class="wrap">
{eyebrow}<h1>{hero}</h1>{sub}
{prebody}
<div class="controls">{"".join(ctrls)}</div>
<div id="count">{n} {noun}{'' if n==1 else 's'}</div>
<div id="grid" data-noun="{esc(noun)}">{cards_html}</div>
{postbody}
{footer}
</div>
{endpoint_js}
<script>{GRID_JS}</script>
<script>{TOGGLE_INLINE_JS}</script>
</body></html>"""


def _sanitize_hero(s: str) -> str:
    """Allow only a single <em>…</em> in the hero; escape everything else."""
    import re
    m = re.match(r"^(.*?)<em>(.*?)</em>(.*)$", s, re.DOTALL)
    if m:
        return esc(m.group(1)) + "<em>" + esc(m.group(2)) + "</em>" + esc(m.group(3))
    return esc(s)


if __name__ == "__main__":
    demo = {
        "title": "demo", "theme": "noir", "eyebrow": "Local · here.now",
        "hero": "Everything we <em>made</em>.", "subtitle": "searchable, private, yours.",
        "count_noun": "doc",
        "facets": [{"id": "kind", "label": "All types", "options": ["html", "pdf", "image", "md"]},
                   {"id": "type", "label": "All sections", "from_cards": True}],
        "sorts": [{"id": "updated", "label": "Newest", "default": True}, {"id": "title", "label": "Title A–Z", "dir": "asc"}],
        "cards": [{"id": "1", "title": "Morning Digest", "href": "#", "eyebrow": "briefs", "kind": "html",
                   "badges": [{"text": "shared"}], "meta": "zephyr-trellis · 3h ago",
                   "facets": {"type": "briefs"}, "sort": {"updated": 100, "title": "morning"},
                   "actions": [{"act": "share", "label": "Share"}, {"act": "delete", "label": "Delete", "danger": True}]}],
    }
    print(render_card_grid(demo))
    import sys
    print("GRID_JS sha256:", grid_js_sha256(), file=sys.stderr)
