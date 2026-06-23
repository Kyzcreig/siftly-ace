/**
 * html_report.ts — render a brief's _render_input.json as a self-contained,
 * dark-mode HTML page with EMBEDDED tweet cards (avatar, name, @handle, FULL
 * untruncated text, inline media) and link-cards for non-tweet stories.
 *
 * Tweets are hydrated via react-tweet's getTweet (same lib the web app uses), so
 * t.co image/video links in the text become real inline media — no naked URLs,
 * no truncation. Fail-safe per item: if a tweet won't hydrate, fall back to a
 * link-card from the render-input fields. Never throws; always emits a page.
 *
 * Usage: tsx scripts/html_report.ts --in <_render_input.json> --out <page.html> [--title "..."]
 * Output: a complete <!doctype html> document on disk.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- react-tweet's Tweet/mediaDetails
   are structurally loose (media variants, blue-verified, conversation_count vary by source);
   render-input items are heterogeneous JSON. Concrete shapes are guarded at each use. */
import { readFileSync, writeFileSync } from 'node:fs'
import { getTweet } from 'react-tweet/api'
import type { Tweet } from 'react-tweet/api'

type Item = Record<string, any>

function arg(name: string, def = ''): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function tweetIdFromUrl(url?: string): string | null {
  const m = /\/status\/(\d+)/.exec(url || '')
  return m ? m[1] : null
}

function fmtCount(n: unknown): string {
  const v = Number(n)
  if (!isFinite(v) || v <= 0) return ''
  if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K'
  return String(v)
}

// Turn a tweet's entity-rich text into HTML: @mentions + #hashtags + links become
// anchors; t.co media links are STRIPPED (the media renders inline below instead).
function renderTweetText(t: Tweet): string {
  const text = t.text || ''
  // also strip the trailing t.co that points at the tweet's own media/quoted
  const urls = (t.entities?.urls || []) as any[]
  let html = esc(text)
  // strip t.co links that are media (they show inline) — match the raw t.co token
  html = html.replace(/https?:\/\/t\.co\/\w+/g, (m) => {
    // if this t.co is a media link, drop it; otherwise keep as a real anchor
    return `\u0000TCO\u0000${m}\u0000`
  })
  // resolve kept t.co → expanded anchor where we have it
  for (const u of urls) {
    const tco = esc(u.url || '')
    const disp = esc(u.display_url || u.expanded_url || u.url || '')
    const exp = esc(u.expanded_url || u.url || '')
    if (!tco) continue
    html = html.replace(`\u0000TCO\u0000${tco}\u0000`, `<a href="${exp}" target="_blank" rel="noopener">${disp}</a>`)
  }
  // any remaining (media) t.co tokens → removed
  html = html.replace(/\u0000TCO\u0000https?:\/\/t\.co\/\w+\u0000/g, '').replace(/\u0000TCO\u0000|\u0000/g, '')
  // @mentions
  html = html.replace(/(^|[^\w@/])@(\w{1,15})\b/g, (_m, pre, h) =>
    `${pre}<a href="https://x.com/${h}" target="_blank" rel="noopener">@${h}</a>`)
  // #hashtags
  html = html.replace(/(^|[^\w&])#(\w+)/g, (_m, pre, h) =>
    `${pre}<a href="https://x.com/hashtag/${h}" target="_blank" rel="noopener">#${h}</a>`)
  return html.replace(/\n/g, '<br>')
}

function mediaHtml(t: Tweet): string {
  const md = (t as any).mediaDetails as any[] | undefined
  if (!md || !md.length) return ''
  const parts: string[] = []
  for (const m of md) {
    if (m.type === 'photo' && m.media_url_https) {
      parts.push(`<a href="${esc(m.media_url_https)}" target="_blank" rel="noopener" class="media-link"><img class="media" src="${esc(m.media_url_https)}" loading="lazy" alt=""></a>`)
    } else if ((m.type === 'video' || m.type === 'animated_gif')) {
      const poster = m.media_url_https ? ` poster="${esc(m.media_url_https)}"` : ''
      const variants = (m.video_info?.variants || []).filter((v: any) => v.content_type === 'video/mp4')
        .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))
      const src = variants[0]?.url
      if (src) parts.push(`<video class="media video" controls preload="none"${poster}><source src="${esc(src)}" type="video/mp4"></video>`)
      else if (m.media_url_https) parts.push(`<img class="media" src="${esc(m.media_url_https)}" loading="lazy" alt="">`)
    }
  }
  return parts.length ? `<div class="media-wrap${md.length > 1 ? ' grid' : ''}">${parts.join('')}</div>` : ''
}

function tweetCard(t: Tweet, scoreBadge: string): string {
  const u = t.user
  const handle = esc(u?.screen_name || '')
  const name = esc(u?.name || handle)
  const avatar = esc(u?.profile_image_url_https || '')
  const verified = u?.verified || (u as any)?.is_blue_verified ? '<span class="verified" title="verified">✔</span>' : ''
  const url = `https://x.com/${handle}/status/${t.id_str}`
  const likes = fmtCount((t as any).favorite_count)
  const replies = fmtCount((t as any).conversation_count)
  const meta = [likes && `♥ ${likes}`, replies && `💬 ${replies}`].filter(Boolean).join(' &nbsp; ')
  return `<article class="tweet">
  <header class="tw-head">
    ${avatar ? `<img class="avatar" src="${avatar}" alt="" loading="lazy">` : ''}
    <div class="who">
      <a class="name" href="https://x.com/${handle}" target="_blank" rel="noopener">${name} ${verified}</a>
      <a class="handle" href="https://x.com/${handle}" target="_blank" rel="noopener">@${handle}</a>
    </div>
    <a class="bird" href="${url}" target="_blank" rel="noopener" title="Open on X">𝕏</a>
  </header>
  <div class="tw-text">${renderTweetText(t)}</div>
  ${mediaHtml(t)}
  <footer class="tw-foot"><span class="eng">${meta}</span>${scoreBadge}<a class="readon" href="${url}" target="_blank" rel="noopener">View on X →</a></footer>
</article>`
}

// Fallback / non-tweet story link-card.
function linkCard(item: Item, scoreBadge: string): string {
  const title = esc(item.title || item.tweet_text || item.text || 'Untitled')
  const url = esc(item.url || '')
  const src = esc(item.source || '')
  const rawHandle = String(item.authorHandle || '').replace(/^@/, '')
  // Only treat it as an X profile handle when the source is X AND it's a real
  // X handle ([A-Za-z0-9_], no Reddit "u/..." / org-slash names like "palmier-io").
  // Pretty source label (avoid "github · GitHub" redundancy). Reddit u/ handles stay as-is.
  const isXProfile = src.toLowerCase() === 'x' && /^[A-Za-z0-9_]{1,15}$/.test(rawHandle)
  const handle = esc(rawHandle)
  const summary = item.summary && String(item.summary).trim() && String(item.summary) !== String(item.title)
    ? `<p class="ln-sum">${esc(item.summary)}</p>` : ''
  const srcLabel = ({ github: 'GitHub', reddit: 'Reddit', hn: 'HN', perplexity: 'Perplexity' } as Record<string, string>)[src.toLowerCase()] || src
  const who = isXProfile
    ? `<a href="https://x.com/${handle}" target="_blank" rel="noopener">@${handle}</a>`
    : `<span class="src">${esc(srcLabel)}</span>`
  const starsToday = item.stars_today != null ? `+${item.stars_today}★ today` : ''
  const meta = [who, starsToday, item.hn_points != null ? `${item.hn_points} pts` : ''].filter(Boolean).join(' · ')
  const head = url ? `<a href="${url}" target="_blank" rel="noopener">${title}</a>` : title
  return `<article class="link-card">
  <h3 class="ln-title">${head}</h3>
  ${summary}
  <div class="ln-meta">${meta} ${scoreBadge}</div>
</article>`
}

function badge(item: Item): string {
  const s = Number(item.score)
  if (!isFinite(s)) return ''
  const [emoji, letter] =
    s >= 93 ? ['🔥', 'A'] : s >= 90 ? ['✅', 'A-'] : s >= 87 ? ['👍', 'B+'] :
    s >= 83 ? ['👍', 'B'] : s >= 80 ? ['📋', 'B-'] : s >= 77 ? ['📋', 'C+'] :
    s >= 73 ? ['📋', 'C'] : ['🔹', 'C-']
  return `<span class="badge">${emoji} ${letter} (${Math.round(s)})</span>`
}

async function renderItem(item: Item): Promise<string> {
  const b = badge(item)
  const id = item.source && String(item.source).toLowerCase() === 'x' ? tweetIdFromUrl(item.url) : null
  if (id) {
    try {
      const t = await getTweet(id)
      if (t && t.user) return tweetCard(t, b)
    } catch { /* fall through to link card */ }
  }
  return linkCard(item, b)
}

const FONT = `<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&display=swap" rel="stylesheet">`

const STYLE = `
:root{--bg:#08090c;--panel:#12141c;--panel2:#171a24;--bd:#242936;--fg:#eef0f6;--mut:#8b92a6;--acc:#7c8cff;--acc2:#52e0c4}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(900px 500px at 80% -10%,rgba(124,140,255,.10),transparent 60%),radial-gradient(700px 400px at -10% 10%,rgba(82,224,196,.07),transparent 55%),var(--bg);color:var(--fg);font-family:"Sora",system-ui,-apple-system,sans-serif;font-size:15.5px;line-height:1.55}
.wrap{max-width:640px;margin:0 auto;padding:30px 18px 80px}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.hd{display:flex;align-items:center;gap:12px;margin-bottom:4px}
.hd .dot{width:11px;height:11px;border-radius:50%;background:linear-gradient(135deg,var(--acc),var(--acc2));box-shadow:0 0 16px var(--acc)}
.hd h1{font-weight:800;font-size:23px;letter-spacing:-.02em;margin:0}
.hd .date{margin-left:auto;color:var(--mut);font-size:13px}
.overview{background:linear-gradient(160deg,var(--panel2),var(--panel));border:1px solid var(--bd);border-radius:18px;padding:18px 20px;margin:16px 0 26px;position:relative;overflow:hidden}
.overview::before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:linear-gradient(var(--acc),var(--acc2))}
.overview h2{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--acc2);margin:0 0 9px;border:0;padding:0}
.overview p{color:#d6dae6;margin:0 0 6px}
.overview ul{display:flex;flex-wrap:wrap;gap:7px;margin:13px 0 0;padding:0;list-style:none}
.overview li{background:#0d1018;border:1px solid var(--bd);border-radius:999px;padding:4px 11px;font-size:12.5px;color:var(--mut)}
.overview li strong{color:var(--fg)}
.sec{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--mut);margin:30px 4px 12px;display:flex;align-items:center;gap:10px}
.sec::after{content:"";flex:1;height:1px;background:var(--bd)}
.tweet,.link-card{background:var(--panel);border:1px solid var(--bd);border-radius:18px;padding:15px 17px;margin:0 0 13px;transition:border-color .15s,transform .15s}
.tweet:hover,.link-card:hover{border-color:#39405a;transform:translateY(-1px)}
.tw-head{display:flex;align-items:center;gap:10px;margin-bottom:9px}
.avatar{width:38px;height:38px;border-radius:50%;flex:0 0 auto;background:#1b1f2b}
.who{display:flex;flex-direction:column;min-width:0;line-height:1.25}
.name{font-weight:700;font-size:14.5px;color:var(--fg)}.verified{color:var(--acc)}
.handle{color:var(--mut);font-size:12.5px}
.bird{margin-left:auto;color:var(--mut);font-size:16px;flex:0 0 auto}
.tw-text{font-size:15px;color:#e7e9f2;white-space:normal;word-wrap:break-word}
.tw-text a{color:var(--acc)}
.media-wrap{margin:11px 0 2px;border-radius:13px;overflow:hidden;border:1px solid var(--bd);max-height:260px}
.media-wrap.grid{display:grid;grid-template-columns:1fr 1fr;gap:4px;max-height:300px}
.media{width:100%;height:260px;object-fit:cover;object-position:top;display:block}
.media-wrap.grid .media{height:148px}
.media.video{height:auto;max-height:260px;object-fit:contain;background:#000}
.tw-foot{display:flex;align-items:center;gap:14px;margin-top:11px;color:var(--mut);font-size:12.5px;flex-wrap:wrap}
.tw-foot .readon{margin-left:auto;color:var(--acc2)}
.badge{background:#0d1018;border:1px solid var(--bd);border-radius:999px;padding:3px 10px;font-size:12px;color:var(--fg);font-weight:700}
.ln-title{margin:0 0 6px;font-size:16px;line-height:1.3;font-weight:600}
.ln-title a{color:var(--fg)}.ln-title a:hover{color:var(--acc)}
.ln-sum{color:var(--mut);font-size:14px;margin:0 0 8px}
.ln-meta{color:var(--mut);font-size:12.5px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ln-meta .src{color:var(--acc2)}
.foot{margin-top:30px;color:var(--mut);font-size:12px;text-align:center}
`

async function main() {
  const inFile = arg('in')
  const outFile = arg('out')
  const title = arg('title') || 'Brief'
  const data: any = JSON.parse(readFileSync(inFile, 'utf8'))
  const selected: Item[] = data.selected || []
  const also: Item[] = data.also || []
  const overview: string = (data.overview || '').trim()
  const footer: string = (data.footer || '').trim()

  // overview is markdown-ish (bold + [text](url) + • bullets) — convert lightly
  function ovHtml(md: string): string {
    const lines = md.split('\n')
    const out: string[] = []
    let inList = false
    for (let ln of lines) {
      ln = ln.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\[\[(\d+)\]\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">[$1]</a>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      if (/^•\s/.test(ln)) { if (!inList) { out.push('<ul>'); inList = true } out.push(`<li>${ln.replace(/^•\s/, '')}</li>`); continue }
      if (inList) { out.push('</ul>'); inList = false }
      if (/^🗞️|^📡/.test(ln)) out.push(`<h2>${ln}</h2>`)
      else if (ln.trim()) out.push(`<p>${ln}</p>`)
    }
    if (inList) out.push('</ul>')
    return out.join('\n')
  }

  const topHtml = (await Promise.all(selected.map(renderItem))).join('\n')
  const alsoHtml = (await Promise.all(also.map(renderItem))).join('\n')

  // split title into name + date if it contains an em-dash (e.g. "Morning Digest — Mon, Jun 22")
  const dm = title.split(/\s+[—–-]\s+/)
  const name = dm[0] || title
  const date = dm.slice(1).join(' — ')

  const body = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(title)}</title>${FONT}<style>${STYLE}</style></head>
<body><div class="wrap">
<div class="hd"><span class="dot"></span><h1>${esc(name)}</h1>${date ? `<span class="date">${esc(date)}</span>` : ''}</div>
${overview ? `<div class="overview">${ovHtml(overview)}</div>` : ''}
${topHtml ? `<div class="sec">🔥 Top Stories</div>${topHtml}` : ''}
${alsoHtml ? `<div class="sec">📊 Also Noted</div>${alsoHtml}` : ''}
${footer ? `<p class="foot">${esc(footer)}</p>` : ''}
</div></body></html>`

  writeFileSync(outFile, body, 'utf8')
  process.stderr.write(`html_report: wrote ${outFile} (${selected.length} top + ${also.length} also)\n`)
}

main().catch((e) => { process.stderr.write(`html_report FATAL: ${e?.message || e}\n`); process.exit(1) })
