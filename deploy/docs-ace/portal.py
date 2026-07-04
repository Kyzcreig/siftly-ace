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
    # style-src/font-src allow Google Fonts (Fraunces/Inter Tight) for the luxe noir theme.
    return ("default-src 'none'; "
            f"script-src 'sha256-{h}'; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com data:; "
            "img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")


CSS = """
@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;0,9..144,600;0,9..144,900;1,9..144,300&family=Inter+Tight:wght@400;500;600&display=swap');
:root{--bg:#0c0c0e;--panel:#141417;--panel2:#1a1a1e;--border:#2e2e34;--fg:#ece8e1;
  --muted:#a49e93;--accent:#d4ac68;--goldsoft:rgba(212,172,104,.15);--chip:#17171b;
  --chip-fg:#c4bdb0;--dim:#6a665e;color-scheme:dark}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);
  font:15px/1.6 "Inter Tight",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  margin:0;padding:40px 28px 60px;
  background-image:radial-gradient(ellipse 80% 50% at 50% -8%,rgba(212,172,104,.08),transparent 60%);
  background-repeat:no-repeat}
.wrap{max-width:1100px;margin:0 auto}
.eyebrow{color:var(--accent);font-size:11px;font-weight:600;letter-spacing:.18em;
  text-transform:uppercase;margin-bottom:10px}
h1{font-family:"Fraunces",Georgia,serif;font-weight:300;font-size:40px;line-height:1.1;
  margin:0 0 6px;letter-spacing:-.01em}
h1 em{font-style:italic;color:var(--accent);font-weight:400}
.sub{color:var(--muted);font-size:14px;margin-bottom:28px}
.searchwrap{position:relative;max-width:560px;margin-bottom:10px}
#q{width:100%;background:var(--panel);border:1px solid var(--border);border-radius:10px;
  color:var(--fg);font:15px "Inter Tight",system-ui,sans-serif;padding:12px 16px 12px 40px}
#q::placeholder{color:var(--muted);opacity:.7}
#q:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--goldsoft)}
.searchwrap::before{content:"⌕";position:absolute;left:14px;top:9px;color:var(--muted);font-size:18px}
#count{color:var(--muted);font-size:12px;letter-spacing:.04em;text-transform:uppercase;margin-bottom:22px}
#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;align-items:stretch}
.card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:18px;
  transition:border-color .18s,transform .18s,box-shadow .18s;position:relative;
  display:flex;flex-direction:column;height:100%}
.card:hover{border-color:rgba(212,172,104,.4);transform:translateY(-2px);
  box-shadow:0 8px 30px rgba(0,0,0,.4)}
.ctype{color:var(--accent);font-size:10px;font-weight:600;letter-spacing:.16em;
  text-transform:uppercase;margin-bottom:9px}
.badge{background:var(--goldsoft);color:var(--accent);border:1px solid rgba(212,172,104,.3);
  border-radius:20px;padding:1px 9px;font-size:9px;letter-spacing:.08em;margin-left:8px;
  text-transform:uppercase}
.badge.shared{background:rgba(212,172,104,.15)}
.ctitle{font-family:"Fraunces",Georgia,serif;color:var(--fg);font-weight:400;font-size:19px;
  line-height:1.25;text-decoration:none;display:block;margin-bottom:8px;letter-spacing:-.005em}
.ctitle:hover{color:var(--accent)}
.cmeta{color:var(--muted);font-size:12px;margin-bottom:14px;font-variant-numeric:tabular-nums}
.cacts{display:flex;gap:7px;flex-wrap:wrap;margin-top:auto}
.cacts button{cursor:pointer;background:var(--chip);border:1px solid var(--border);
  border-radius:8px;color:var(--chip-fg);font:12px "Inter Tight",system-ui,sans-serif;
  padding:5px 12px;transition:border-color .15s,color .15s,background .15s}
.cacts button:hover{border-color:var(--accent);color:var(--accent);background:var(--goldsoft)}
.cacts button.danger:hover{border-color:#c0563e;color:#e08a72;background:rgba(192,86,62,.1)}
.cacts button:disabled{opacity:.45;cursor:default}
.empty{color:var(--muted);font-family:"Fraunces",serif;font-style:italic;font-size:17px;padding:20px 0}
@media(max-width:640px){body{padding:28px 18px 40px}h1{font-size:32px}#grid{grid-template-columns:1fr}}
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
    n = len(docs)
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>docs.ace</title><style>{CSS}</style></head><body>
<div class="wrap">
<div class="eyebrow">Local · here.now</div>
<h1>Everything we <em>made</em>, in one place.</h1>
<div class="sub">Briefs, docs & reports — searchable, private, yours.</div>
<div class="searchwrap"><input id="q" type="search" placeholder="Search titles + body text…" autocomplete="off"></div>
<div id="count">{n} doc{'' if n==1 else 's'}</div>
<div id="grid">{cards}</div>
</div>
<script>{PORTAL_JS}</script>
</body></html>"""
