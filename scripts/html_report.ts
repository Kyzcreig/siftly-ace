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
import { translateToEnglish } from '../lib/translate'

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
// `overrideText` (a translation) replaces the body text while keeping entity linking.
function renderTweetText(t: Tweet, overrideText?: string): string {
  const text = overrideText ?? t.text ?? ''
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

function tweetCard(t: Tweet, scoreBadge: string, tr?: { text: string; srcLang: string }): string {
  const u = t.user
  const handle = esc(u?.screen_name || '')
  const name = esc(u?.name || handle)
  const avatar = esc(u?.profile_image_url_https || '')
  const verified = u?.verified || (u as any)?.is_blue_verified ? '<span class="verified" title="verified"></span>' : ''
  const url = `https://x.com/${handle}/status/${t.id_str}`
  const likes = fmtCount((t as any).favorite_count)
  const replies = fmtCount((t as any).conversation_count)
  const meta = [likes && `♥ ${likes}`, replies && `💬 ${replies}`].filter(Boolean).join(' &nbsp; ')
  const trTag = tr && tr.srcLang ? `<span class="tr-tag">translated from ${esc(tr.srcLang)}</span>` : ''
  return `<article class="tweet">
  <header class="tw-head">
    ${avatar ? `<img class="avatar" src="${avatar}" alt="" loading="lazy">` : ''}
    <div class="who">
      <a class="name" href="https://x.com/${handle}" target="_blank" rel="noopener">${name} ${verified}</a>
      <a class="handle" href="https://x.com/${handle}" target="_blank" rel="noopener">@${handle}</a>
    </div>
    <a class="bird" href="${url}" target="_blank" rel="noopener" title="Open on X">𝕏</a>
  </header>
  <div class="tw-text">${renderTweetText(t, tr?.text)}</div>${trTag}
  ${mediaHtml(t)}
  <footer class="tw-foot"><span class="eng">${meta}</span>${scoreBadge}<a class="readon" href="${url}" target="_blank" rel="noopener">View on X →</a></footer>
</article>`
}

// Fallback / non-tweet story link-card.
function linkCard(item: Item, scoreBadge: string, tr?: { text: string; srcLang: string }): string {
  const title = esc(item.title || item.tweet_text || item.text || 'Untitled')
  const url = esc(item.url || '')
  const src = esc(item.source || '')
  const rawHandle = String(item.authorHandle || '').replace(/^@/, '')
  // Only treat it as an X profile handle when the source is X AND it's a real
  // X handle ([A-Za-z0-9_], no Reddit "u/..." / org-slash names like "palmier-io").
  // Pretty source label (avoid "github · GitHub" redundancy). Reddit u/ handles stay as-is.
  const isXProfile = src.toLowerCase() === 'x' && /^[A-Za-z0-9_]{1,15}$/.test(rawHandle)
  const handle = esc(rawHandle)
  // Story summary: translated if foreign (option B), capped at 300 chars for display.
  const rawSummary = tr?.text ?? (item.summary != null ? String(item.summary) : '')
  const cappedSummary = capText(rawSummary, 300)
  const trTag = tr && tr.srcLang ? `<span class="tr-tag">translated from ${esc(tr.srcLang)}</span>` : ''
  const summary = cappedSummary.trim() && cappedSummary.trim() !== String(item.title)
    ? `<p class="ln-sum">${esc(cappedSummary)}</p>${trTag}` : ''
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

// Cap a string to ~limit chars at a word boundary (no mid-word cut); add an
// ellipsis only when we actually trimmed. Tweets are NEVER capped (Ace's call);
// only non-tweet story summaries pass through here.
function capText(s: string, limit: number): string {
  const t = (s || '').trim()
  if (t.length <= limit) return t
  const cut = t.slice(0, limit)
  const sp = cut.lastIndexOf(' ')
  return (sp > limit * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…'
}

function badge(item: Item): string {
  const s = Number(item.score)
  if (!isFinite(s)) return ''
  // Noir grade pill (mockup .grade): plain "A− · 90", NO colored emoji (keeps the
  // palette gold-only — a green ✅/👍 would break the single-accent rule).
  const letter =
    s >= 93 ? 'A' : s >= 90 ? 'A−' : s >= 87 ? 'B+' :
    s >= 83 ? 'B' : s >= 80 ? 'B−' : s >= 77 ? 'C+' :
    s >= 73 ? 'C' : 'C−'
  return `<span class="badge">${letter} · ${Math.round(s)}</span>`
}

async function renderItem(item: Item): Promise<string> {
  const b = badge(item)
  const id = item.source && String(item.source).toLowerCase() === 'x' ? tweetIdFromUrl(item.url) : null
  if (id) {
    try {
      const t = await getTweet(id)
      if (t && t.user) {
        // react-tweet's syndication API truncates LONG ("note") tweets to ~280 chars
        // (note_tweet body isn't exposed there). Our authenticated gather DID capture
        // the full text into item.tweet_text — prefer it when it's genuinely longer so
        // long tweets render in full. Strip trailing media t.co the renderer drops anyway.
        const hydrated = t.text || ''
        const stored = String(item.tweet_text || '')
        const fuller = stored.replace(/\s+https?:\/\/t\.co\/\w+\s*$/g, '').trim()
        const base = fuller.length > hydrated.length ? fuller : hydrated
        // Translate foreign tweet body to English (option B: replace + tag). Fail-safe.
        const tr = await translateToEnglish(base)
        const override = tr.translated ? { text: tr.text, srcLang: tr.srcLang }
          : (base !== hydrated ? { text: base, srcLang: '' } : undefined)
        return tweetCard(t, b, override)
      }
    } catch { /* fall through to link card */ }
  }
  // non-tweet story: translate the summary if it's foreign
  const tr = await translateToEnglish(item.summary != null ? String(item.summary) : '')
  return linkCard(item, b, tr.translated ? { text: tr.text, srcLang: tr.srcLang } : undefined)
}

const FONT = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;0,9..144,600;0,9..144,900;1,9..144,300;1,9..144,400&family=Inter+Tight:wght@400;500;600&display=swap" rel="stylesheet">`

const STYLE = `
:root{--bg:#0c0c0e;--bg2:#141417;--fg:#ece8e1;--dim:#8a857c;--line:#26262b;--gold:#c9a25e;--goldsoft:rgba(201,162,94,.14)}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font-family:"Inter Tight",system-ui,-apple-system,sans-serif;font-size:16px;line-height:1.6;background-image:radial-gradient(ellipse 80% 50% at 50% -10%,rgba(201,162,94,.07),transparent 60%)}
.wrap{max-width:720px;margin:0 auto;padding:54px 30px 100px}
a{color:var(--gold);text-decoration:none}
/* header */
.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:46px}
.brand{display:flex;align-items:center;gap:11px}
.brand .dot{width:9px;height:9px;border-radius:50%;background:var(--gold);box-shadow:0 0 14px var(--gold)}
.brand .nm{font-family:"Fraunces",Georgia,serif;font-weight:600;font-size:16px;letter-spacing:.02em}
.top .dt{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--dim)}
.hero{margin-bottom:38px}
.hero .eyebrow{font-size:11px;letter-spacing:.4em;text-transform:uppercase;color:var(--gold);margin-bottom:14px}
.hero h1{font-family:"Fraunces",Georgia,serif;font-weight:300;font-size:54px;line-height:1.02;letter-spacing:-.02em}
.hero h1 em{font-style:italic;font-weight:400;color:var(--gold)}
/* overview */
.overview{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:24px 0;margin-bottom:46px}
.overview h2{font-family:"Fraunces",Georgia,serif;font-style:italic;font-weight:400;font-size:15px;color:var(--gold);margin:0 0 12px;border:0;padding:0;letter-spacing:0;text-transform:none}
.overview p{font-size:17px;color:#d6d1c8;margin:0 0 11px;line-height:1.65}
.overview a{color:var(--gold);border-bottom:1px solid var(--goldsoft)}
.overview ul{list-style:none;margin:16px 0 0;padding:0;display:flex;flex-direction:column;gap:9px}
.overview li{font-size:14.5px;color:var(--dim);padding-left:18px;position:relative;line-height:1.5}
.overview li::before{content:"—";position:absolute;left:0;color:var(--gold)}
.overview li strong{color:var(--fg);font-weight:600}
/* section labels */
.sec{font-size:11px;letter-spacing:.34em;text-transform:uppercase;color:var(--dim);margin:0 0 22px;display:flex;align-items:center;gap:14px}
.sec::after{content:"";flex:1;height:1px;background:var(--line)}
/* article shell (tweet + link card share this) */
.tweet,.link-card{margin-bottom:34px;padding-bottom:34px;border-bottom:1px solid var(--line)}
.tweet:last-child,.link-card:last-child{border-bottom:none}
/* tweet card — Noir token map (D-5/fold-in 3) */
.tw-head{display:flex;align-items:center;gap:11px;margin-bottom:13px}
.avatar{width:42px;height:42px;border-radius:50%;flex:0 0 auto;background:var(--bg2)}
.who{display:flex;flex-direction:column;min-width:0;line-height:1.3}
.name{font-family:"Inter Tight",sans-serif;font-weight:600;font-size:15px;color:var(--fg)}
.verified{display:inline-block;width:14px;height:14px;border-radius:50%;background:var(--gold);position:relative;vertical-align:middle;margin-left:1px;flex:0 0 auto}
.verified::after{content:"";position:absolute;left:4.5px;top:2.5px;width:3px;height:6px;border:solid var(--bg);border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
.handle{color:var(--dim);font-size:13px}
.bird{margin-left:auto;color:var(--gold);font-size:17px;flex:0 0 auto}
.tw-text{font-size:16.5px;color:#d6d1c8;line-height:1.6;white-space:normal;word-wrap:break-word}
.tw-text a{color:var(--gold);border-bottom:1px solid var(--goldsoft)}
.media-wrap{margin:14px 0 2px;border-radius:10px;overflow:hidden;border:1px solid var(--line);max-height:300px}
.media-wrap.grid{display:grid;grid-template-columns:1fr 1fr;gap:4px;max-height:320px}
.media{width:100%;height:300px;object-fit:cover;object-position:top;display:block}
.media-wrap.grid .media{height:165px}
.media.video{height:auto;max-height:300px;object-fit:contain;background:#000}
.tw-foot{display:flex;align-items:center;gap:16px;margin-top:14px;padding-top:13px;border-top:1px solid var(--line);color:var(--dim);font-size:12.5px;flex-wrap:wrap}
.tw-foot .eng{color:var(--dim)}
.media-link{display:block}
.tw-foot .readon{margin-left:auto;color:var(--gold);text-transform:uppercase;letter-spacing:.12em;font-size:11px}
.tw-foot .readon:hover{letter-spacing:.18em}
/* score badge / grade pill (mockup .grade) */
.badge{background:var(--bg2);border:1px solid var(--line);border-radius:20px;padding:2px 11px;font-size:11px;color:var(--dim);font-weight:500;letter-spacing:.04em}
/* link card — Noir story */
.ln-title{font-family:"Fraunces",Georgia,serif;font-weight:400;font-size:25px;line-height:1.18;margin:0 0 10px;letter-spacing:-.01em}
.ln-title a{color:var(--fg)}.ln-title a:hover{color:var(--gold)}
.ln-sum{font-size:16px;color:#bdb8af;line-height:1.62;margin:0 0 10px}
.ln-meta{color:var(--dim);font-size:13px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;letter-spacing:.02em}
.ln-meta .src{color:var(--gold);text-transform:uppercase;font-size:10px;letter-spacing:.15em}
.tr-tag{display:inline-block;margin-top:6px;font-size:11px;color:var(--dim);font-style:italic;opacity:.8}
/* footer */
.foot{margin-top:56px;text-align:center;font-size:12px;color:var(--dim);letter-spacing:.04em;line-height:2.1;border-top:1px solid var(--line);padding-top:22px}
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
      // Header line: detect by the 🗞️/📡 marker, but STRIP the colored emoji from the
      // rendered label so the overview stays gold-mono (Noir: clean italic "The Landscape").
      if (/^🗞️|^📡/.test(ln)) { out.push(`<h2>${ln.replace(/^(🗞️|📡)\uFE0F?\s*/, '').trim()}</h2>`); continue }
      if (ln.trim()) out.push(`<p>${ln}</p>`)
    }
    if (inList) out.push('</ul>')
    return out.join('\n')
  }

  const topHtml = (await Promise.all(selected.map(renderItem))).join('\n')
  const alsoHtml = (await Promise.all(also.map(renderItem))).join('\n')

  // split title into date suffix (e.g. "Morning Digest — Mon, Jun 22" → date). The
  // brand wordmark is the fixed "Siftly"; the brief name lives in the eyebrow.
  const dm = title.split(/\s+[—–-]\s+/)
  const date = dm.slice(1).join(' — ')

  // Noir hero: brief-detect from the title → eyebrow + big italic hero line (fold-in 2).
  const tl = title.toLowerCase()
  const isX = tl.includes('x feed') || tl.includes('x-feed') || tl.includes('timeline')
  const eyebrow = isX ? 'Your X Feed' : 'The Morning Digest'
  const heroLine = isX
    ? 'What your feed was <em>really</em> saying.'
    : 'What moved in <em>AI</em> while you slept.'

  const body = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(title)}</title>${FONT}<style>${STYLE}</style></head>
<body><div class="wrap">
<div class="top"><div class="brand"><span class="dot"></span><span class="nm">Siftly</span></div>${date ? `<span class="dt">${esc(date)}</span>` : ''}</div>
<div class="hero"><div class="eyebrow">${esc(eyebrow)}</div><h1>${heroLine}</h1></div>
${overview ? `<div class="overview">${ovHtml(overview)}</div>` : ''}
${topHtml ? `<div class="sec">Top Stories</div>${topHtml}` : ''}
${alsoHtml ? `<div class="sec">Also Noted</div>${alsoHtml}` : ''}
${footer ? `<p class="foot">${footer.split('\n').map((l) => esc(l)).join('<br>')}</p>` : ''}
</div></body></html>`

  writeFileSync(outFile, body, 'utf8')
  process.stderr.write(`html_report: wrote ${outFile} (${selected.length} top + ${also.length} also)\n`)
}

main().catch((e) => { process.stderr.write(`html_report FATAL: ${e?.message || e}\n`); process.exit(1) })
