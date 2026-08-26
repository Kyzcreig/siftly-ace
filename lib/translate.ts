/**
 * translate.ts — fail-safe, on-demand translation of non-English item text for the
 * HTML report (Ace's call 2026-06-24: replace foreign text with English + a small
 * "translated from X" tag — option B).
 *
 * Design:
 *  - Detection is CHEAP and LOCAL (script regex). English / Latin-only text never
 *    triggers an API call, so the common case costs nothing.
 *  - Translation uses the repo's existing resolveAIClient() (same client embeddings/
 *    search use). One short call per non-English item; results cached in-process so a
 *    repeated string (or re-render) doesn't re-pay.
 *  - FAIL-SAFE: any error (no key, network, bad response) returns the ORIGINAL text
 *    untouched. Translation must NEVER break the report build (it's on the post path).
 *  - Toggle: SIFTLY_TRANSLATE=0 disables entirely (returns original).
 */
import { resolveAIClientForProvider, type AIClient } from './ai-client'
import { getActiveModelFor } from './settings'

export interface Translated {
  text: string          // English (or original if untranslated)
  translated: boolean    // true only when we actually replaced foreign text
  srcLang: string        // English language name of detected source, e.g. "French", "Chinese"
}

// Script ranges that indicate non-English content worth translating. Latin-script
// languages (French/Spanish/German/...) are handled separately by the stopword
// heuristic detectLatinForeign() below — x.com translates those too.
// Labels are English language names (x.com parity: "Translated from Japanese").
const SCRIPTS: Array<{ re: RegExp; label: string }> = [
  { re: /[\u3040-\u30ff]/, label: 'Japanese' },                    // Hiragana/Katakana (check FIRST: JP text also has Han)
  { re: /[\uac00-\ud7af]/, label: 'Korean' },                      // Hangul
  { re: /[\u4e00-\u9fff\u3400-\u4dbf]/, label: 'Chinese' },        // CJK Han
  { re: /[\u0400-\u04ff]/, label: 'Russian' },                     // Cyrillic
  { re: /[\u0600-\u06ff\u0750-\u077f]/, label: 'Arabic' },         // Arabic
  { re: /[\u0590-\u05ff]/, label: 'Hebrew' },                      // Hebrew
  { re: /[\u0e00-\u0e7f]/, label: 'Thai' },                        // Thai
  { re: /[\u0900-\u097f]/, label: 'Hindi' },                       // Devanagari
]

/** Detect the dominant non-English script, or null if the text is English/Latin. */
export function detectForeign(text: string): string | null {
  if (!text) return null
  // Count CJK-ish chars; require a small threshold so a stray emoji/symbol or a
  // single foreign char in an otherwise-English tweet doesn't trigger a translation.
  for (const { re, label } of SCRIPTS) {
    const g = new RegExp(re.source, 'g')
    const hits = (text.match(g) || []).length
    if (hits >= 3) return label
  }
  return null
}

// ── Latin-script language detection (French/Spanish/German/Portuguese/Italian) ──
// x.com translates these too (Ace's example was a French tweet), so a script-only
// detector misses the most common case. Cheap local stopword heuristic: count
// distinctive function-word hits per language; require a clear margin over English
// so an English tweet can never trigger a paid API call. Tokens chosen to avoid
// English collisions (no "a", "on", "as"...).
const LATIN_LANGS: Array<{ label: string; words: Set<string> }> = [
  { label: 'French', words: new Set(['le', 'la', 'les', 'des', 'une', 'est', 'et', 'que', 'qui', 'dans', 'pour', 'pas', 'avec', 'sur', 'je', 'vous', 'nous', 'ce', 'cette', 'du', 'au', 'aux', 'mais', 'plus', 'être', 'sont', 'ça', 'très', 'comme', 'fait', 'aussi', 'bien', 'tout', 'tous', 'même', 'où', 'donc', 'quand', 'parce', 'depuis', 'était', 'j\u2019ai', "j'ai", 'c\u2019est', "c'est", 'n\u2019est', "n'est"]) },
  { label: 'Spanish', words: new Set(['el', 'los', 'las', 'una', 'es', 'y', 'que', 'en', 'por', 'para', 'con', 'del', 'se', 'su', 'lo', 'como', 'más', 'pero', 'este', 'esta', 'son', 'muy', 'ya', 'hay', 'sí', 'también', 'porque', 'cuando', 'todo', 'nos', 'está', 'sobre', 'entre', 'desde', 'hasta']) },
  { label: 'German', words: new Set(['der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'ein', 'eine', 'für', 'auf', 'von', 'zu', 'dem', 'den', 'sich', 'auch', 'wir', 'ich', 'aber', 'wenn', 'oder', 'wird', 'sind', 'nur', 'noch', 'wie', 'bei', 'nach', 'werden', 'einen', 'schon', 'mehr', 'durch', 'sehr']) },
  { label: 'Portuguese', words: new Set(['os', 'um', 'uma', 'é', 'e', 'que', 'em', 'para', 'por', 'com', 'do', 'da', 'dos', 'das', 'se', 'não', 'mais', 'como', 'mas', 'foi', 'são', 'você', 'muito', 'também', 'quando', 'isso', 'está', 'já', 'porque', 'sobre', 'tem', 'ao', 'pelo', 'pela']) },
  { label: 'Italian', words: new Set(['il', 'lo', 'gli', 'una', 'è', 'che', 'per', 'con', 'del', 'della', 'si', 'non', 'più', 'come', 'ma', 'sono', 'anche', 'questo', 'questa', 'molto', 'ci', 'nel', 'alla', 'dei', 'delle', 'perché', 'quando', 'essere', 'stato', 'hanno', 'può']) },
]
const ENGLISH_WORDS = new Set(['the', 'and', 'is', 'are', 'to', 'of', 'in', 'that', 'it', 'for', 'with', 'this', 'was', 'you', 'have', 'not', 'be', 'at', 'we', 'they', 'from', 'but', 'what', 'all', 'can', 'your', 'my', 'so', 'if', 'will', 'just', 'about', 'how', 'when', 'out', 'get', 'like', 'now', 'has', 'more'])

/** Detect a Latin-script non-English language, or null. Conservative: needs ≥4
 *  distinctive hits AND a clear margin over English stopword hits. */
export function detectLatinForeign(text: string): string | null {
  if (!text) return null
  // strip urls/mentions/hashtags so tokens are real words
  const cleaned = text.replace(/https?:\/\/\S+|[@#]\w+/g, ' ').toLowerCase()
  const tokens = cleaned.split(/[^a-zà-öø-ÿœ'\u2019]+/).filter(Boolean)
  if (tokens.length < 6) return null // too short to judge reliably
  let en = 0
  for (const t of tokens) if (ENGLISH_WORDS.has(t)) en++
  let best: { label: string; hits: number } | null = null
  for (const { label, words } of LATIN_LANGS) {
    let hits = 0
    for (const t of tokens) if (words.has(t)) hits++
    if (!best || hits > best.hits) best = { label, hits }
  }
  if (best && best.hits >= 4 && best.hits > en * 2 && best.hits / tokens.length >= 0.12) return best.label
  return null
}

const cache = new Map<string, Translated>()

function enabled(): boolean {
  return process.env.SIFTLY_TRANSLATE !== '0'
}

// Per-provider default translation model, used when SIFTLY_TRANSLATE_MODEL isn't
// set AND the DB model lookup can't be reached. Detection already proved the text
// is foreign, so we must NOT let a DB hiccup silently drop the translation.
const DEFAULT_MODEL: Record<'anthropic' | 'openai' | 'minimax', string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  minimax: 'MiniMax-M2.7',
}

// Resolve the active model for a provider, but NEVER throw. The report build path
// runs under a node whose native better-sqlite3 ABI may not match (the DB lookup in
// getActiveModelFor() then throws) — fall back to a known-good default so a broken
// DB binding can't silently disable translation on the post path.
async function getModelSafe(provider: 'anthropic' | 'openai' | 'minimax'): Promise<string> {
  if (process.env.SIFTLY_TRANSLATE_MODEL) return process.env.SIFTLY_TRANSLATE_MODEL
  try {
    return await getActiveModelFor(provider)
  } catch {
    return DEFAULT_MODEL[provider]
  }
}

// Resolve the configured provider, but never throw (the DB may be unreachable in the
// build context). Default to 'anthropic' to match getProvider()'s own default.
async function getProviderSafe(): Promise<'anthropic' | 'openai' | 'minimax'> {
  try {
    const { getProvider } = await import('./settings')
    return await getProvider()
  } catch {
    return 'anthropic'
  }
}

/**
 * Translate to English IF the text is non-English; otherwise return it unchanged.
 * Never throws — on any failure returns the original text with translated=false.
 */
export async function translateToEnglish(text: string): Promise<Translated> {
  const original: Translated = { text, translated: false, srcLang: '' }
  if (!enabled() || !text || !text.trim()) return original
  // Script-based detection first (CJK/Cyrillic/etc.), then the Latin-language
  // stopword heuristic (French/Spanish/... — the x.com-parity case Ace asked for).
  const srcLang = detectForeign(text) || detectLatinForeign(text)
  if (!srcLang) return original
  const key = text
  const hit = cache.get(key)
  if (hit) return hit
  try {
    // Route translation through the SUBSCRIPTION lane (cliproxyapi :18812), never
    // the metered OpenAI API. 2026-08-26: the metered-API leak sentinel caught this
    // exact path — with-secrets.sh provisions OPENAI_API_KEY (legitimately, for
    // embeddings), translateToEnglish preferred provider 'openai' whenever that key
    // was in env, and the model fell back to settings.ts's 'gpt-4.1-mini' default →
    // 1 billed chat request per foreign post in the brief. Chat completions on the
    // metered key violate the subscription doctrine (embeddings/TTS/STT only).
    // SIFTLY_TRANSLATE_BASE_URL + SIFTLY_TRANSLATE_API_KEY (set in with-secrets.sh)
    // pin the translation client to the proxy; without them we now prefer the
    // configured provider (anthropic default) instead of metered OpenAI.
    const proxyBase = process.env.SIFTLY_TRANSLATE_BASE_URL
    const proxyKey = process.env.SIFTLY_TRANSLATE_API_KEY
    let client: AIClient
    let model: string
    if (proxyBase && proxyKey) {
      const { OpenAIAIClient } = await import('./ai-client')
      const OpenAI = (await import('openai')).default
      client = new OpenAIAIClient(new OpenAI({ apiKey: proxyKey, baseURL: proxyBase }))
      model = process.env.SIFTLY_TRANSLATE_MODEL || 'gpt-5.6-terra'
    } else {
      const provider = await getProviderSafe()
      client = await resolveAIClientForProvider(provider)
      model = await getModelSafe(provider)
    }
    const res = await client.createMessage({
      model,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content:
          'Translate the following social-media post to natural English. Output ONLY the ' +
          'translation — no preamble, no quotes, no notes. Preserve @mentions, #hashtags, ' +
          'URLs, emoji, $tickers, and code/product names exactly as written.\n\n' + text,
      }],
    })
    const out = (res.text || '').trim()
    if (!out || out === text) return original
    const result: Translated = { text: out, translated: true, srcLang }
    cache.set(key, result)
    return result
  } catch {
    return original  // fail-safe: never break the report on a translation hiccup
  }
}
