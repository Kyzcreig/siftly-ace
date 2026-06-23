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
  let text = t.text || ''
  const mediaTcos = new Set<string>((t as any).mediaDetails?.map((m: any) => m?.url).filter(Boolean) || [])
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
      if (src) parts.push(`<video class="media" controls preload="none"${poster}><source src="${esc(src)}" type="video/mp4"></video>`)
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
  const isXProfile = src.toLowerCase() === 'x' && /^[A-Za-z0-9_]{1,15}$/.test(rawHandle)
  const handle = esc(rawHandle)
  const summary = item.summary && String(item.summary).trim() && String(item.summary) !== String(item.title)
    ? `<p class="ln-sum">${esc(item.summary)}</p>` : ''
  const who = isXProfile
    ? `<a href="https://x.com/${handle}" target="_blank" rel="noopener">@${handle}</a>`
    : (rawHandle ? esc(rawHandle.includes('/') ? rawHandle : '@' + rawHandle) : src)
  const meta = [who, item.hn_points != null ? `${item.hn_points} pts` : ''].filter(Boolean).join(' · ')
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

const STYLE = `
:root{--bg:#0d1117;--panel:#161b22;--bd:#30363d;--fg:#e6edf3;--mut:#8b949e;--acc:#58a6ff;--accd:#1f6feb}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:28px 18px 64px}
h1{font-size:26px;margin:0 0 4px} .sub{color:var(--mut);margin:0 0 24px;font-size:14px}
h2{font-size:18px;margin:34px 0 14px;padding-bottom:6px;border-bottom:1px solid var(--bd)}
a{color:var(--acc);text-decoration:none} a:hover{text-decoration:underline}
.overview{background:var(--panel);border:1px solid var(--bd);border-radius:14px;padding:16px 18px;margin:0 0 8px}
.overview h2{margin-top:0;border:0;padding:0}
.overview ul{margin:10px 0 0;padding-left:18px} .overview li{margin:3px 0}
.tweet,.link-card{background:var(--panel);border:1px solid var(--bd);border-radius:14px;padding:14px 16px;margin:0 0 14px}
.tw-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.avatar{width:44px;height:44px;border-radius:50%;flex:0 0 auto;background:#222}
.who{display:flex;flex-direction:column;min-width:0;flex:1}
.name{font-weight:700;color:var(--fg)} .verified{color:var(--acc)}
.handle{color:var(--mut);font-size:14px}
.bird{color:var(--mut);font-size:18px;flex:0 0 auto}
.tw-text{font-size:16px;white-space:normal;word-wrap:break-word}
.media-wrap{margin:12px 0 4px;border-radius:12px;overflow:hidden}
.media-wrap.grid{display:grid;grid-template-columns:1fr 1fr;gap:4px}
.media{width:100%;height:auto;display:block;border-radius:12px;border:1px solid var(--bd)}
.tw-foot{display:flex;align-items:center;gap:12px;margin-top:12px;color:var(--mut);font-size:13px;flex-wrap:wrap}
.tw-foot .readon{margin-left:auto;color:var(--acc)}
.badge{background:#21262d;border:1px solid var(--bd);border-radius:999px;padding:1px 9px;font-size:12px;color:var(--fg)}
.ln-title{margin:0 0 6px;font-size:17px;line-height:1.35}
.ln-sum{margin:0 0 8px;color:#c9d1d9;font-size:15px}
.ln-meta{color:var(--mut);font-size:13px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
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

  const body = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><div class="wrap">
<h1>${esc(title)}</h1>
${overview ? `<div class="overview">${ovHtml(overview)}</div>` : ''}
${topHtml ? `<h2>🔥 Top Stories</h2>${topHtml}` : ''}
${alsoHtml ? `<h2>📊 Also Noted</h2>${alsoHtml}` : ''}
${footer ? `<p class="foot">${esc(footer)}</p>` : ''}
</div></body></html>`

  writeFileSync(outFile, body, 'utf8')
  process.stderr.write(`html_report: wrote ${outFile} (${selected.length} top + ${also.length} also)\n`)
}

main().catch((e) => { process.stderr.write(`html_report FATAL: ${e?.message || e}\n`); process.exit(1) })
