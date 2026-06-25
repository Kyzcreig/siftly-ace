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
  srcLang: string        // human label of detected source script, e.g. "中文"
}

// Script ranges that indicate non-English content worth translating. Latin (incl.
// accented), digits, punctuation, emoji do NOT count — a French/Spanish tweet with
// only Latin chars is left as-is (rare, low value, and risks over-translating names).
const SCRIPTS: Array<{ re: RegExp; label: string }> = [
  { re: /[\u3040-\u30ff]/, label: '日本語' },                      // Hiragana/Katakana (check FIRST: JP text also has Han)
  { re: /[\uac00-\ud7af]/, label: '한국어' },                      // Hangul
  { re: /[\u4e00-\u9fff\u3400-\u4dbf]/, label: '中文' },          // CJK Han
  { re: /[\u0400-\u04ff]/, label: 'Русский' },                    // Cyrillic
  { re: /[\u0600-\u06ff\u0750-\u077f]/, label: 'العربية' },        // Arabic
  { re: /[\u0590-\u05ff]/, label: 'עברית' },                       // Hebrew
  { re: /[\u0e00-\u0e7f]/, label: 'ไทย' },                         // Thai
  { re: /[\u0900-\u097f]/, label: 'हिन्दी' },                      // Devanagari
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
  const srcLang = detectForeign(text)
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
