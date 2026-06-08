import { describe, expect, it, vi } from 'vitest'

import { checkCreditFloor } from '@/lib/credit-guard'

function usagePayload(projectCap: number, projectUsage: number) {
  return {
    data: {
      project_cap: projectCap,
      project_usage: projectUsage,
      cap_reset_day: 9,
    },
  }
}

function response(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
}

describe('checkCreditFloor', () => {
  it('computes remaining credits from project_cap minus project_usage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, usagePayload(2_000_000, 6_166)))

    const result = await checkCreditFloor({ reserve: 50_000, bearer: 'app-only-bearer', fetchImpl })

    expect(result.remaining).toBe(1_993_834)
    expect(result.reserve).toBe(50_000)
    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith('https://api.x.com/2/usage/tweets', {
      headers: { Authorization: 'Bearer app-only-bearer' },
    })
  })

  it('blocks when remaining credits are below the reserve', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, usagePayload(100_000, 50_001)))

    const result = await checkCreditFloor({ reserve: 50_000, bearer: 'app-only-bearer', fetchImpl })

    expect(result).toMatchObject({ remaining: 49_999, reserve: 50_000, ok: false })
    expect(result.reason).toMatch(/below reserve/i)
  })

  it('allows when remaining credits equal the reserve', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, usagePayload(100_000, 50_000)))

    const result = await checkCreditFloor({ reserve: 50_000, bearer: 'app-only-bearer', fetchImpl })

    expect(result).toMatchObject({ remaining: 50_000, reserve: 50_000, ok: true })
  })

  it('allows when remaining credits are above the reserve', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, usagePayload(100_000, 49_999)))

    const result = await checkCreditFloor({ reserve: 50_000, bearer: 'app-only-bearer', fetchImpl })

    expect(result).toMatchObject({ remaining: 50_001, reserve: 50_000, ok: true })
  })

  it('flags user-token 403 as a CONFIG error instead of a credit shortfall', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(403, {
      title: 'Unsupported Authentication',
      detail: 'Unsupported Authentication. Authenticating with OAuth 2.0 User Context is forbidden for this endpoint.',
    }))

    const result = await checkCreditFloor({ reserve: 50_000, bearer: 'user-token', fetchImpl })

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/CONFIG/i)
    expect(result.reason).toMatch(/usage endpoint needs app-only bearer/i)
    expect(result.reason).not.toMatch(/no credits/i)
  })

  it('fails closed on parse failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, 'not json'))

    const result = await checkCreditFloor({ reserve: 50_000, bearer: 'app-only-bearer', fetchImpl })

    expect(result).toMatchObject({ remaining: null, reserve: 50_000, ok: false })
    expect(result.reason).toMatch(/parse/i)
  })

  it('fails closed on network errors', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('socket closed'))

    const result = await checkCreditFloor({ reserve: 50_000, bearer: 'app-only-bearer', fetchImpl })

    expect(result).toMatchObject({ remaining: null, reserve: 50_000, ok: false })
    expect(result.reason).toMatch(/network/i)
  })

  it('allows structurally unavailable balance only with a batch cap and off-window constraint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(404, { title: 'Not Found' }))
    const warn = vi.fn()

    const result = await checkCreditFloor({
      reserve: 50_000,
      bearer: 'app-only-bearer',
      fetchImpl,
      batchCap: 1_000,
      offWindow: true,
      logger: { warn },
    })

    expect(result).toMatchObject({ remaining: null, reserve: 50_000, ok: true, balanceUnavailable: true })
    expect(result.reason).toMatch(/batch cap/i)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('balance unavailable'))
  })

  it('fails closed when structurally unavailable balance lacks the caveat constraints', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(404, { title: 'Not Found' }))

    const result = await checkCreditFloor({ reserve: 50_000, bearer: 'app-only-bearer', fetchImpl })

    expect(result).toMatchObject({ remaining: null, reserve: 50_000, ok: false, balanceUnavailable: true })
    expect(result.reason).toMatch(/balance unavailable/i)
  })
})
