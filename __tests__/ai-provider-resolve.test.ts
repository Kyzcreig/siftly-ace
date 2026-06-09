import { describe, expect, it } from 'vitest'

import {
  resolveProvider,
  PROVIDER_PRECEDENCE,
  type ProviderKeyAvailability,
} from '@/lib/ai-provider-resolve'

const none: ProviderKeyAvailability = { openai: false, anthropic: false, minimax: false }

describe('resolveProvider (Wave 5 F3 — RC4/RC5)', () => {
  it('uses the DB-preferred provider when its key is present', () => {
    const r = resolveProvider('anthropic', { ...none, anthropic: true })
    expect(r.provider).toBe('anthropic')
    expect(r.reason).toBe('db-preferred')
    expect(r.warning).toBeUndefined()
  })

  it('the real bug: preferred=anthropic but only OPENAI key present -> auto-picks openai, never null', () => {
    const r = resolveProvider('anthropic', { ...none, openai: true })
    expect(r.provider).toBe('openai')
    expect(r.reason).toBe('auto-picked')
    expect(r.preferred).toBe('anthropic')
    expect(r.warning).toMatch(/anthropic/)
    expect(r.warning).toMatch(/openai/)
  })

  it('auto-picks by fixed precedence (openai > anthropic > minimax) when preferred is unusable', () => {
    // preferred=minimax unusable; both anthropic and openai available -> openai wins
    const r = resolveProvider('minimax', { openai: true, anthropic: true, minimax: false })
    expect(r.provider).toBe('openai')
    expect(r.reason).toBe('auto-picked')
  })

  it('auto-picks anthropic when openai absent but anthropic+minimax present', () => {
    const r = resolveProvider('openai', { openai: false, anthropic: true, minimax: true })
    expect(r.provider).toBe('anthropic')
    expect(r.reason).toBe('auto-picked')
  })

  it('returns null (fast clear error path) when NO provider has a usable key', () => {
    const r = resolveProvider('anthropic', none)
    expect(r.provider).toBeNull()
    expect(r.reason).toBe('no-usable-key')
    expect(r.preferred).toBe('anthropic')
  })

  it('prefers the DB provider even when others are also available (no needless auto-pick)', () => {
    const r = resolveProvider('minimax', { openai: true, anthropic: true, minimax: true })
    expect(r.provider).toBe('minimax')
    expect(r.reason).toBe('db-preferred')
  })

  it('precedence constant is the documented fixed order', () => {
    expect(PROVIDER_PRECEDENCE).toEqual(['openai', 'anthropic', 'minimax'])
  })

  it('is deterministic — same inputs always yield the same resolution', () => {
    const avail = { openai: false, anthropic: true, minimax: true }
    const a = resolveProvider('openai', avail)
    const b = resolveProvider('openai', avail)
    expect(a).toEqual(b)
  })
})
