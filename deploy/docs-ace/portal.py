#!/usr/bin/env python3
"""portal.py — the docs.ace dashboard (Phase 4): here.now-style cards + full-text search,
plus Share / Revoke / Delete actions (Phase 5). Rendered by docs_host at the apex host.

House look mirrors the ace-dashboard-portal-generators kit (GitHub-dark, cards, mobile).
Progressive-enhancement search: the card list is server-rendered (works no-JS); the JS adds
the live search box hitting /api/search + the per-doc action buttons.
"""
from __future__ import annotations

import hashlib
import html
import json
import time

# The portal's own inline script (search + actions). Its sha256 is pinned in PORTAL_CSP.
PORTAL_JS = r"""
(function(){
  "use strict";
  var box=document.getElementById('q'), grid=document.getElementById('grid');
  function esc(s){var d=document.createElement('div');d.textContent=s||'';return d.innerHTML;}
  function ago(ts){var s=Math.floor(Date.now()/1000)-ts;if(s<3600)return Math.floor(s/60)+'m ago';
    if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago';}
  function card(d){
    var shared=d.herenow_slug?'<span class="badge shared">shared</span>':'';
    return '<article class="card" data-slug="'+esc(d.slug)+'">'+
      '<div class="ctype">'+esc(d.type)+' '+shared+'</div>'+
      '<a class="ctitle" href="https://'+esc(d.slug)+'.docs.ace/" target="_blank">'+esc(d.title||d.slug)+'</a>'+
      '<div class="cmeta">'+esc(d.slug)+' · '+ago(d.updated)+'</div>'+
      '<div class="cacts">'+
        '<button data-act="share">'+(d.herenow_slug?'Re-share':'Share')+'</button>'+
        (d.herenow_slug?'<button data-act="revoke">Revoke share</button>':'')+
        '<button data-act="delete" class="danger">Delete</button>'+
      '</div></article>';
  }
  function render(list){grid.innerHTML=list.length?list.map(card).join(''):'<p class="empty">No docs.</p>';
    document.getElementById('count').textContent=list.length+' doc'+(list.length===1?'':'s');}
  var t;
  function run(){clearTimeout(t);t=setTimeout(function(){
    fetch('/api/search?q='+encodeURIComponent(box.value)).then(function(r){return r.json();})
      .then(function(j){render(j.results||[]);});
  },160);}
  if(box){box.addEventListener('input',run);}
  function post(url,body){return fetch(url,{method:'POST',
    headers:{'Content-Type':'application/json','X-Docs-Ace-CSRF':'1'},
    body:JSON.stringify(body)}).then(function(r){return r.ok?r.json():Promise.reject(r.status);});}
  grid.addEventListener('click',function(e){
    var b=e.target.closest('[data-act]');if(!b)return;
    var slug=b.closest('.card').getAttribute('data-slug');var act=b.getAttribute('data-act');
    if(act==='delete'&&!confirm('Delete '+slug+'? (soft-delete, removes from portal + host)'))return;
    if(act==='revoke'&&!confirm('Revoke the public here.now share for '+slug+'?'))return;
    b.disabled=true;
    post('/api/doc/'+act,{slug:slug}).then(function(j){
      if(act==='share'&&j.url){navigator.clipboard&&navigator.clipboard.writeText(j.url);window.open(j.url,'_blank');}
      run();
    }).catch(function(c){b.disabled=false;alert(act+' failed ('+c+')');});
  });
})();
"""

PORTAL_JS_SHA256 = hashlib.sha256(PORTAL_JS.encode()).digest()


def portal_csp() -> str:
    import base64
    h = base64.b64encode(PORTAL_JS_SHA256).decode()
    return ("default-src 'none'; "
            f"script-src 'sha256-{h}'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")


CSS = """
:root{color-scheme:dark}
*{box-sizing:border-box}
body{background:#0d1117;color:#e6edf3;font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:24px}
h1{font-size:22px;margin:0 0 4px;font-weight:650}
.sub{color:#8b949e;font-size:13px;margin-bottom:20px}
#q{width:100%;max-width:520px;background:#161b22;border:1px solid #30363d;border-radius:8px;
  color:#e6edf3;font-size:15px;padding:10px 14px;margin-bottom:8px}
#q:focus{outline:none;border-color:#1f6feb}
#count{color:#8b949e;font-size:12px;margin-bottom:16px}
#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:14px}
.ctype{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.badge{background:#1f6feb33;color:#58a6ff;border-radius:10px;padding:1px 7px;font-size:10px;margin-left:6px}
.badge.shared{background:#23863633;color:#3fb950}
.ctitle{color:#e6edf3;font-weight:600;text-decoration:none;display:block;margin-bottom:6px;font-size:15px}
.ctitle:hover{color:#58a6ff}
.cmeta{color:#8b949e;font-size:12px;margin-bottom:10px}
.cacts{display:flex;gap:6px;flex-wrap:wrap}
.cacts button{cursor:pointer;background:#21262d;border:1px solid #30363d;border-radius:6px;
  color:#c9d1d9;font-size:12px;padding:4px 10px}
.cacts button:hover{border-color:#8b949e}
.cacts button.danger:hover{border-color:#f85149;color:#f85149}
.cacts button:disabled{opacity:.5}
.empty{color:#8b949e}
@media(max-width:600px){#grid{grid-template-columns:1fr}}
"""


def render_portal() -> str:
    try:
        import docs_index
        docs = docs_index.list_docs()
    except Exception:
        docs = []

    def card(d):
        shared = '<span class="badge shared">shared</span>' if d.get("herenow_slug") else ""
        title = html.escape(d.get("title") or d.get("slug"))
        slug = html.escape(d["slug"])
        typ = html.escape(d.get("type", ""))
        acts = ('<button data-act="share">' + ("Re-share" if d.get("herenow_slug") else "Share") + '</button>'
                + ('<button data-act="revoke">Revoke share</button>' if d.get("herenow_slug") else "")
                + '<button data-act="delete" class="danger">Delete</button>')
        return (f'<article class="card" data-slug="{slug}">'
                f'<div class="ctype">{typ} {shared}</div>'
                f'<a class="ctitle" href="https://{slug}.docs.ace/" target="_blank">{title}</a>'
                f'<div class="cmeta">{slug}</div>'
                f'<div class="cacts">{acts}</div></article>')

    cards = "".join(card(d) for d in docs) or '<p class="empty">No docs yet.</p>'
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>docs.ace</title><style>{CSS}</style></head><body>
<h1>docs.ace</h1><div class="sub">local here.now — briefs & docs, searchable</div>
<input id="q" type="search" placeholder="Search titles + body text…" autocomplete="off">
<div id="count">{len(docs)} doc{'' if len(docs)==1 else 's'}</div>
<div id="grid">{cards}</div>
<script>{PORTAL_JS}</script>
</body></html>"""
