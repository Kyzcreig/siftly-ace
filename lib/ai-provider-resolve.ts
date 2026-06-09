/**
 * AI provider resolution for /api/search/ai — Wave 5 Feature 3 (RC4/RC5).
 *
 * The web search box must NEVER silently fall through to the 90s CLI agentic path
 * just because the DB-configured provider has no usable key in the running process.
 * This module is a PURE function (no DB, no env reads of its own) so it can be unit
 * tested deterministically. The route passes in:
 *   - the DB-preferred provider (from getProvider())
 *   - whether a DB API key string is present for the preferred provider
 *   - which providers have a usable SDK key visible RIGHT NOW (env + db), computed
 *     by the caller at request time (bypasses getProvider()'s 5-min in-process cache)
 *
 * Resolution rules (deterministic):
 *  1. If the DB-preferred provider has a usable key  -> use it (reason: 'db-preferred').
 *  2. Else if any OTHER provider has a usable key    -> auto-pick by fixed precedence,
 *                                                       log a loud warning (reason: 'auto-picked').
 *  3. Else                                           -> no usable key for ANY provider;
 *                                                       caller returns a fast clear error
 *                                                       (reason: 'no-usable-key').
 *
 * Fixed auto-pick precedence when the DB provider is unusable/unset: openai, anthropic, minimax.
 * (OpenAI first: it is the production-injected key via with-secrets.sh.)
 */

export type AIProvider = 'anthropic' | 'openai' | 'minimax'

export const PROVIDER_PRECEDENCE: readonly AIProvider[] = ['openai', 'anthropic', 'minimax'] as const

export interface ProviderKeyAvailability {
  openai: boolean
  anthropic: boolean
  minimax: boolean
}

export type ResolveReason = 'db-preferred' | 'auto-picked' | 'no-usable-key'

export interface ResolvedProvider {
  /** The provider the request should actually use, or null if none is usable. */
  provider: AIProvider | null
  reason: ResolveReason
  /** The DB-preferred provider we started from (for diagnostics). */
  preferred: AIProvider
  /** Human-readable warning when we auto-picked away from the preferred provider. */
  warning?: string
}

/**
 * Resolve which provider to use, keyed off ACTUAL key availability (RC4) with
 * deterministic precedence (RC5). Pure — no side effects.
 */
export function resolveProvider(
  preferred: AIProvider,
  available: ProviderKeyAvailability,
): ResolvedProvider {
  // 1. DB-preferred provider is directly usable.
  if (available[preferred]) {
    return { provider: preferred, reason: 'db-preferred', preferred }
  }

  // 2. Auto-pick the first provider (by fixed precedence) that has a usable key.
  for (const candidate of PROVIDER_PRECEDENCE) {
    if (available[candidate]) {
      return {
        provider: candidate,
        reason: 'auto-picked',
        preferred,
        warning:
          `AI-search: configured provider "${preferred}" has no usable API key in this process; ` +
          `auto-selected "${candidate}" (key present). Set aiProvider/key in Settings to silence this.`,
      }
    }
  }

  // 3. No provider has a usable key.
  return { provider: null, reason: 'no-usable-key', preferred }
}
