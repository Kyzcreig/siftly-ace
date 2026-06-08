export const POST_READ_RATE_USD = 0.005

export interface PostReadCostEstimate {
  reads: number
  rateUsdPerRead: number
  costUsd: number
  formattedCostUsd: string
}

export interface PageCeilingCostInput {
  maxPages: number
  pageSize: number
}

export interface IngestCostGateInput extends PageCeilingCostInput {
  dryRun: boolean
  confirm: boolean
  incremental: boolean
}

export interface IngestCostGateDecision {
  proceed: boolean
  estimate: PostReadCostEstimate | null
}

export function estimatePostReadCost(
  reads: number,
  rateUsdPerRead = POST_READ_RATE_USD,
): PostReadCostEstimate {
  assertNonNegativeInteger(reads, 'reads')
  assertFinitePositive(rateUsdPerRead, 'rateUsdPerRead')

  const costUsd = reads * rateUsdPerRead
  return {
    reads,
    rateUsdPerRead,
    costUsd,
    formattedCostUsd: formatUsd(costUsd),
  }
}

export function estimatePageCeilingCost(input: PageCeilingCostInput): PostReadCostEstimate {
  assertNonNegativeInteger(input.maxPages, 'maxPages')
  assertNonNegativeInteger(input.pageSize, 'pageSize')
  return estimatePostReadCost(input.maxPages * input.pageSize)
}

export function formatCostEstimate(estimate: PostReadCostEstimate): string {
  return `est: ${estimate.reads} reads ~= $${estimate.formattedCostUsd} (rate $${formatRate(estimate.rateUsdPerRead)}/read)`
}

export function evaluateIngestCostGate(input: IngestCostGateInput): IngestCostGateDecision {
  if (input.dryRun || input.incremental) {
    return { proceed: true, estimate: null }
  }

  return {
    proceed: input.confirm,
    estimate: estimatePageCeilingCost(input),
  }
}

function formatUsd(amount: number): string {
  return (Math.round((amount + Number.EPSILON) * 100) / 100).toFixed(2)
}

function formatRate(rate: number): string {
  return rate.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }
}

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be positive`)
  }
}
