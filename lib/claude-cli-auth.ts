import { execSync, spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import Anthropic from '@anthropic-ai/sdk'

// Re-export CLI utilities for text-based tasks
export { claudePrompt, getCliAvailability, modelNameToCliAlias } from './claude-cli'

interface ClaudeOAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  subscriptionType: string
  rateLimitTier: string
}

// Module-level cache to avoid repeated I/O on every request
let cachedCredentials: ClaudeOAuthCredentials | null = null
let cacheReadAt = 0
const CACHE_TTL_MS = 60_000 // 1 minute

/**
 * Parses OAuth credentials from raw JSON string.
 */
function parseOAuthCredentials(raw: string): ClaudeOAuthCredentials | null {
  try {
    const parsed = JSON.parse(raw)
    const oauth = parsed?.claudeAiOauth
    if (!oauth?.accessToken) return null
    return oauth as ClaudeOAuthCredentials
  } catch {
    return null
  }
}

/**
 * Reads Claude Code CLI credentials from macOS Keychain.
 */
function readMacCredentials(): ClaudeOAuthCredentials | null {
  try {
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
      encoding: 'utf8',
      timeout: 3000,
    }).trim()
    if (!raw) return null
    return parseOAuthCredentials(raw)
  } catch {
    return null
  }
}

/**
 * Reads Claude Code CLI credentials from ~/.claude/.credentials.json (Windows/Linux).
 */
function readFileCredentials(): ClaudeOAuthCredentials | null {
  try {
    const credPath = join(homedir(), '.claude', '.credentials.json')
    const raw = readFileSync(credPath, 'utf8')
    return parseOAuthCredentials(raw)
  } catch {
    return null
  }
}

/**
 * Reads Claude Code CLI credentials from the system credential store.
 * Supports macOS Keychain and Windows/Linux file-based storage.
 * Results are cached for 1 minute to avoid repeated I/O.
 * Returns null if CLI not installed or not logged in.
 */
function readCliCredentials(): ClaudeOAuthCredentials | null {
  const now = Date.now()

  // Return cached credentials if still valid
  if (cachedCredentials && now - cacheReadAt < CACHE_TTL_MS) {
    // But check if token has expired
    if (now <= cachedCredentials.expiresAt) {
      return cachedCredentials
    }
  }

  // Read fresh credentials
  const creds = process.platform === 'darwin'
    ? readMacCredentials()
    : readFileCredentials()

  cachedCredentials = creds
  cacheReadAt = now
  return creds
}

/**
 * Returns a valid OAuth access token from the logged-in Claude CLI session.
 * Returns null if not available or expired.
 *
 * The token must be used with:
 *   Authorization: Bearer <token>
 *   anthropic-beta: oauth-2025-04-20
 */
export function getCliOAuthToken(): string | null {
  const creds = readCliCredentials()
  if (!creds) return null

  // Token expired — user needs to run `claude` to refresh
  if (Date.now() > creds.expiresAt) return null

  return creds.accessToken
}

/**
 * Creates an Anthropic client using the ANTHROPIC_CLI_KEY env var as an OAuth Bearer token.
 * Use this in Docker/Linux where the macOS keychain is unavailable but you have a CLI OAuth token.
 * Returns null if ANTHROPIC_CLI_KEY is not set.
 */
export function createEnvCliAnthropicClient(baseURL?: string): Anthropic | null {
  const token = process.env.ANTHROPIC_CLI_KEY?.trim()
  if (!token) return null

  return new Anthropic({
    authToken: token,
    defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
    ...(baseURL ? { baseURL } : {}),
  })
}

/**
 * Creates an Anthropic client using the logged-in Claude CLI session.
 * Uses the OAuth Bearer token flow with the required anthropic-beta header.
 * Returns null if CLI auth is not available.
 */
export function createCliAnthropicClient(baseURL?: string): Anthropic | null {
  const token = getCliOAuthToken()
  if (!token) return null

  return new Anthropic({
    authToken: token,
    defaultHeaders: {
      // Required header to enable OAuth token auth with the Anthropic API
      'anthropic-beta': 'oauth-2025-04-20',
    },
    ...(baseURL ? { baseURL } : {}),
  })
}

/**
 * Returns auth status for the settings UI.
 */
export function getCliAuthStatus(): {
  available: boolean
  subscriptionType?: string
  expired?: boolean
} {
  const creds = readCliCredentials()
  if (!creds) return { available: false }

  const expired = Date.now() > creds.expiresAt
  return {
    available: true,
    subscriptionType: creds.subscriptionType,
    expired,
  }
}

/**
 * Resolves an Anthropic client using the first available auth method:
 * 1. Override key (explicit key from request)
 * 2. DB-saved API key (pass pre-fetched to avoid async)
 * 3. Logged-in Claude CLI session (OAuth Bearer via keychain)
 * 4. ANTHROPIC_CLI_KEY env var (OAuth token for Docker/Linux)
 * 5. ANTHROPIC_API_KEY env var
 * 6. Local proxy via ANTHROPIC_BASE_URL
 *
 * CLI auth is checked before env var so .env placeholders don't block CLI users.
 *
 * @param options.overrideKey - Explicit key from request body
 * @param options.dbKey - Pre-fetched key from prisma.setting (avoids async import)
 * @param options.baseURL - Custom base URL (defaults to ANTHROPIC_BASE_URL env)
 * @throws Error if no auth method is available
 */
export function resolveAnthropicClient(options: {
  overrideKey?: string
  dbKey?: string
  baseURL?: string
} = {}): Anthropic {
  const baseURL = options.baseURL ?? process.env.ANTHROPIC_BASE_URL

  // 1. Override key from request
  if (options.overrideKey?.trim()) {
    return new Anthropic({ apiKey: options.overrideKey.trim(), ...(baseURL ? { baseURL } : {}) })
  }

  // 2. DB-saved key
  if (options.dbKey?.trim()) {
    return new Anthropic({ apiKey: options.dbKey.trim(), ...(baseURL ? { baseURL } : {}) })
  }

  // 3. CLI auth via keychain (before env var to avoid .env placeholder blocking)
  const cliClient = createCliAnthropicClient(baseURL)
  if (cliClient) return cliClient

  // 4. ANTHROPIC_CLI_KEY env var (Docker/Linux: CLI OAuth token passed via env)
  const envCliClient = createEnvCliAnthropicClient(baseURL)
  if (envCliClient) return envCliClient

  // 5. ANTHROPIC_API_KEY environment variable
  const envKey = process.env.ANTHROPIC_API_KEY?.trim()
  if (envKey) {
    return new Anthropic({ apiKey: envKey, ...(baseURL ? { baseURL } : {}) })
  }

  // 6. Local proxy (assumes proxy handles auth)
  if (baseURL) {
    return new Anthropic({ apiKey: 'proxy', baseURL })
  }

  throw new Error('No Anthropic API key found. Add your key in Settings, or log in with Claude CLI.')
}
