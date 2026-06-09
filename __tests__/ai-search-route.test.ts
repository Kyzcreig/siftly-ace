/**
 * Route-level integration test for POST /api/search/ai — Wave 5 Feature 3 hardening.
 *
 * The pure resolver (ai-provider-resolve.test.ts) proves the DECISION logic. This test
 * proves the WIRING: that the real route handler actually probes key availability at
 * request time and short-circuits the 90s CLI agentic path. We drive the real handler
 * with mocked boundaries (prisma, SDK client, CLI libs) and assert the hardened
 * behaviors that a screenshot/unit test would miss:
 *
 *   1. DB provider=anthropic but only OPENAI_API_KEY present -> resolves via OpenAI SDK,
 *      returns 200, and NEVER calls the codex/claude CLI (no 90s hang).
 *   2. No usable key for ANY provider -> fast clear 400 with the provider named, and the
 *      CLI is never invoked.
 *   3. Empty query -> fast 400 (basic guard intact).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mock boundaries BEFORE importing the route ────────────────────────────────
const settingValues = new Map<string, string>()
const bookmarkFindMany = vi.fn()
const categoryFindMany = vi.fn(async () => [])

vi.mock('@/lib/db', () => ({
  default: {
    setting: {
      findUnique: vi.fn(async ({ where: { key } }: { where: { key: string } }) => {
        const v = settingValues.get(key)
        return v === undefined ? null : { key, value: v }
      }),
    },
    bookmark: { findMany: (...args: unknown[]) => (bookmarkFindMany as (...a: unknown[]) => unknown)(...args) },
    category: { findMany: (...args: unknown[]) => (categoryFindMany as (...a: unknown[]) => unknown)(...args) },
  },
}))

vi.mock('@/lib/fts', () => ({ ftsSearch: vi.fn(async () => []) }))
vi.mock('@/lib/search-utils', () => ({ extractKeywords: (q: string) => q.split(/\s+/).filter(Boolean) }))

// SDK client mock — returns one valid match so the OpenAI path can "succeed".
const createMessage = vi.fn(async () => ({
  text: JSON.stringify({
    queryIntent: 'test',
    matches: [{ id: 'bk1', score: 0.9, reason: 'matches the query well' }],
    explanation: 'found one',
  }),
}))
const resolveAIClientForProvider = vi.fn(async (provider: string) => ({ provider, createMessage }))
vi.mock('@/lib/ai-client', () => ({
  resolveAIClientForProvider: (...args: unknown[]) => (resolveAIClientForProvider as (...a: unknown[]) => unknown)(...args),
}))

// CLI libs — spied so we can PROVE they are never called on the hardened paths.
const codexPrompt = vi.fn(async () => ({ success: true, data: '{"matches":[],"explanation":"cli"}' }))
const claudePrompt = vi.fn(async () => ({ success: true, data: '{"matches":[],"explanation":"cli"}' }))
const getCodexCliAvailability = vi.fn(async () => true)
const getCliAvailability = vi.fn(async () => true)
vi.mock('@/lib/codex-cli', () => ({
  codexPrompt: (...a: unknown[]) => (codexPrompt as (...x: unknown[]) => unknown)(...a),
  getCodexCliAvailability: () => getCodexCliAvailability(),
}))
vi.mock('@/lib/claude-cli-auth', () => ({
  claudePrompt: (...a: unknown[]) => (claudePrompt as (...x: unknown[]) => unknown)(...a),
  getCliAvailability: () => getCliAvailability(),
  modelNameToCliAlias: (m: string) => m,
}))

import { POST } from '@/app/api/search/ai/route'

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/search/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0]
}

const ENV_KEYS = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_CLI_KEY', 'ANTHROPIC_BASE_URL', 'MINIMAX_API_KEY', 'MINIMAX_BASE_URL']
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  vi.clearAllMocks()
  settingValues.clear()
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
  // One candidate bookmark so the handler reaches the AI step.
  bookmarkFindMany.mockImplementation(async () => [{
    id: 'bk1', tweetId: '1', text: 'a tweet about local LLM inference', authorHandle: 'a', authorName: 'A',
    tweetCreatedAt: new Date(), importedAt: new Date(), semanticTags: null, entities: null,
    mediaItems: [], categories: [],
  }])
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('POST /api/search/ai — F3 hardening (wiring)', () => {
  it('DB provider=anthropic but only OPENAI key present -> OpenAI SDK, 200, NEVER the 90s CLI', async () => {
    settingValues.set('aiProvider', 'anthropic') // preferred = anthropic (unusable: no anthropic key)
    process.env.OPENAI_API_KEY = 'fake-test-key-not-a-secret'

    const res = await POST(makeRequest({ query: 'anthropic-preferred openai-key case' }))
    expect(res.status).toBe(200)
    const data = await res.json() as { bookmarks: unknown[]; explanation: string }
    expect(data.bookmarks.length).toBe(1)
    // Resolved provider must be the auto-picked openai, not the preferred anthropic.
    expect(resolveAIClientForProvider).toHaveBeenCalledWith('openai', expect.anything())
    // The hardening guarantee: the agentic CLI path was never touched.
    expect(codexPrompt).not.toHaveBeenCalled()
    expect(claudePrompt).not.toHaveBeenCalled()
  })

  it('no usable key for any provider -> fast 400 naming the provider, CLI never invoked', async () => {
    settingValues.set('aiProvider', 'anthropic')
    // no env keys set (beforeEach cleared them), no DB keys -> nothing usable

    const res = await POST(makeRequest({ query: 'anything' }))
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string; provider: string }
    expect(data.provider).toBe('anthropic')
    expect(data.error).toMatch(/no usable/i)
    expect(resolveAIClientForProvider).not.toHaveBeenCalled()
    expect(codexPrompt).not.toHaveBeenCalled()
    expect(claudePrompt).not.toHaveBeenCalled()
  })

  it('empty query -> fast 400 (basic guard intact)', async () => {
    const res = await POST(makeRequest({ query: '   ' }))
    expect(res.status).toBe(400)
    expect(codexPrompt).not.toHaveBeenCalled()
    expect(claudePrompt).not.toHaveBeenCalled()
  })

  it('DB provider=openai with the key present -> uses openai directly (db-preferred, no auto-pick)', async () => {
    settingValues.set('aiProvider', 'openai')
    process.env.OPENAI_API_KEY = 'fake-test-key-not-a-secret'

    const res = await POST(makeRequest({ query: 'openai-preferred direct case' }))
    expect(res.status).toBe(200)
    expect(resolveAIClientForProvider).toHaveBeenCalledWith('openai', expect.anything())
    expect(codexPrompt).not.toHaveBeenCalled()
    expect(claudePrompt).not.toHaveBeenCalled()
  })
})
