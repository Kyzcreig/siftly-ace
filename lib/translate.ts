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
import { resolveAIClientForProvider } from './ai-client'
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
    // Prefer OpenAI when its key is in env (the report build path provisions
    // OPENAI_API_KEY via with-secrets.sh); otherwise fall back to the configured
    // provider. Avoids a DB provider lookup the build context may not satisfy.
    const provider = process.env.OPENAI_API_KEY ? 'openai' as const : await getProviderSafe()
    const client = await resolveAIClientForProvider(provider)
    const model = process.env.SIFTLY_TRANSLATE_MODEL || await getActiveModelFor(provider)
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
