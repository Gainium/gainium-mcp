#!/usr/bin/env node

import { randomUUID, createHash } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest,
  type IsomorphicHeaders,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { GainiumClient } from './gainium-client.js'

// ── Environment ──────────────────────────────────────────────────────────────

const SERVER_NAME = 'gainium-mcp'
const SERVER_VERSION = '3.2.1'

const API_KEY = process.env.GAINIUM_API_KEY
const API_SECRET = process.env.GAINIUM_API_SECRET
const ALLOWED_BOT_ID = process.env.GAINIUM_ALLOWED_BOT_ID?.trim() || undefined
const PAPER_ONLY =
  process.env.GAINIUM_PAPER_ONLY?.trim().toLowerCase() === 'true'
const BASE_URL = process.env.GAINIUM_API_BASE_URL || 'https://api.gainium.io'
const TRANSPORT_MODE = resolveTransportMode(
  process.env.GAINIUM_MCP_TRANSPORT || process.env.MCP_TRANSPORT,
)
const HTTP_HOST =
  process.env.GAINIUM_MCP_HOST || process.env.MCP_HOST || '127.0.0.1'
const HTTP_PORT = resolvePort(
  process.env.GAINIUM_MCP_PORT || process.env.MCP_PORT || process.env.PORT,
  3000,
)
const MCP_HTTP_PATH = normalizePath(
  process.env.GAINIUM_MCP_HTTP_PATH || process.env.MCP_HTTP_PATH || '/mcp',
)
const MCP_SSE_PATH = normalizePath(
  process.env.GAINIUM_MCP_SSE_PATH || process.env.MCP_SSE_PATH || '/sse',
)
const MCP_MESSAGES_PATH = normalizePath(
  process.env.GAINIUM_MCP_MESSAGES_PATH ||
    process.env.MCP_MESSAGES_PATH ||
    '/messages',
)

// ── OAuth resource server (hosted HTTP mode) ───────────────────────────────
// When GAINIUM_OAUTH_ISSUER + MCP_INTROSPECTION_SECRET are set and the
// transport is HTTP, this server acts as an OAuth 2.1 protected resource
// (MCP auth spec + RFC 9728): it advertises the authorization server, rejects
// unauthenticated requests with 401 + WWW-Authenticate, and resolves the
// Bearer access token to the user's Gainium (apiKey, apiSecret) via the auth
// server's introspection endpoint. The local-stdio env-var path is untouched.
const OAUTH_ISSUER =
  process.env.GAINIUM_OAUTH_ISSUER?.trim().replace(/\/$/, '') || undefined
const INTROSPECTION_URL =
  process.env.GAINIUM_INTROSPECTION_URL?.trim() ||
  (OAUTH_ISSUER ? `${OAUTH_ISSUER}/oauth/introspect` : undefined)
const INTROSPECTION_SECRET = process.env.MCP_INTROSPECTION_SECRET?.trim() || undefined
// Optional fixed public base (e.g. https://mcp.gainium.io) for the resource
// metadata; otherwise derived from the request host.
const MCP_PUBLIC_URL =
  process.env.GAINIUM_MCP_PUBLIC_URL?.trim().replace(/\/$/, '') || undefined
const OAUTH_ENABLED = Boolean(
  OAUTH_ISSUER && INTROSPECTION_URL && INTROSPECTION_SECRET,
)
// This server's own RFC 8707 resource URI (its audience). When the public URL
// is known, a token whose audience is a *different* resource (e.g. a token
// minted for the read-only `…/read` connector presented to the full `…/mcp`
// endpoint, or vice versa) is rejected. Tokens with no audience (legacy grants
// / clients that don't send `resource`) are accepted for back-compat.
const EXPECTED_RESOURCE = MCP_PUBLIC_URL
  ? `${MCP_PUBLIC_URL}${MCP_HTTP_PATH}`
  : undefined
// OpenAI Apps domain-verification token. OpenAI's submission flow fetches
// /.well-known/openai-apps-challenge on the MCP origin and expects the exact
// challenge token back as the response body. Set via env so the token can be
// rotated without a code change.
const OPENAI_APPS_CHALLENGE_TOKEN =
  process.env.OPENAI_APPS_CHALLENGE_TOKEN?.trim() || undefined

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolveTransportMode(value: string | undefined): 'stdio' | 'http' {
  switch ((value || 'stdio').trim().toLowerCase()) {
    case '':
    case 'stdio':
      return 'stdio'
    case 'http':
    case 'sse':
    case 'http-sse':
    case 'streamable-http':
      return 'http'
    default:
      throw new Error(
        `Unsupported transport mode: ${value}. Use one of: stdio, http, streamable-http, sse, http-sse`,
      )
  }
}

function resolvePort(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid port: ${value}`)
  }

  return parsed
}

function normalizePath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return '/'
  }

  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function getHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function getRequestHeader(
  headers: IsomorphicHeaders | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined
  }

  const targetName = name.toLowerCase()
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerName.toLowerCase() === targetName) {
      return getHeaderValue(headerValue)
    }
  }

  return undefined
}

function extractBearer(
  value: string | string[] | undefined,
): string | undefined {
  const v = Array.isArray(value) ? value[0] : value
  if (!v) {
    return undefined
  }
  const match = /^Bearer\s+(.+)$/i.exec(v.trim())
  return match ? match[1].trim() : undefined
}

interface IntrospectionResult {
  active: boolean
  apiKey?: string
  apiSecret?: string
  scope?: string
  /** RFC 8707 audience — the resource URI the token was minted for. */
  aud?: string
  restrictions?: {
    permission?: string
    paperContext?: boolean | null
    botId?: string | null
  }
}

const introspectionCache = new Map<
  string,
  { result: IntrospectionResult; expiresAt: number }
>()
const INTROSPECTION_TTL_MS = 60_000

// Validate an access token against the authorization server's introspection
// endpoint and resolve it to the user's Gainium credentials. Results are
// cached briefly so repeated tool calls in a session don't re-introspect.
async function introspectToken(token: string): Promise<IntrospectionResult> {
  if (!OAUTH_ENABLED || !INTROSPECTION_URL || !INTROSPECTION_SECRET) {
    return { active: false }
  }
  const cacheKey = createHash('sha256').update(token).digest('hex')
  const cached = introspectionCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result
  }

  let result: IntrospectionResult = { active: false }
  try {
    const res = await fetch(INTROSPECTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${INTROSPECTION_SECRET}`,
      },
      body: new URLSearchParams({ token }).toString(),
    })
    if (res.ok) {
      const data: any = await res.json()
      result = data?.active
        ? {
            active: true,
            apiKey: data.gainium_api_key,
            apiSecret: data.gainium_api_secret,
            scope: data.scope,
            aud: data.aud,
            restrictions: data.restrictions,
          }
        : { active: false }
    }
  } catch (error) {
    console.error(`[${SERVER_NAME}] introspection failed:`, error)
    return { active: false }
  }

  // Cache active results for the full TTL; inactive ones briefly to avoid
  // hammering the auth server on a bad token.
  introspectionCache.set(cacheKey, {
    result,
    expiresAt: Date.now() + (result.active ? INTROSPECTION_TTL_MS : 5_000),
  })
  return result
}

// A token is for us if it carries no audience (legacy) or its audience equals
// this server's resource. A token minted for another resource is rejected.
function audienceAllowed(intro: IntrospectionResult): boolean {
  if (!EXPECTED_RESOURCE || !intro.aud) return true
  return intro.aud === EXPECTED_RESOURCE
}

async function createGainiumClientFromHeaders(
  headers: IsomorphicHeaders | undefined,
): Promise<GainiumClient> {
  // Hosted OAuth mode: the Bearer access token resolves to the user's key.
  if (OAUTH_ENABLED) {
    const token = extractBearer(getRequestHeader(headers, 'authorization'))
    if (token) {
      const intro = await introspectToken(token)
      if (
        intro.active &&
        intro.apiKey &&
        intro.apiSecret &&
        audienceAllowed(intro)
      ) {
        return new GainiumClient(BASE_URL, intro.apiKey, intro.apiSecret)
      }
    }
    throw new Error(
      'Unauthorized: a valid OAuth access token is required to access this Gainium MCP server.',
    )
  }

  // Local stdio / self-hosted: X-API-Key/X-API-Secret headers or env vars.
  const apiKey = getRequestHeader(headers, 'x-api-key') || API_KEY
  const apiSecret = getRequestHeader(headers, 'x-api-secret') || API_SECRET

  if (!apiKey || !apiSecret) {
    throw new Error(
      "Missing Gainium credentials. Provide 'X-API-Key' and 'X-API-Secret' request headers for hosted HTTP mode, or set GAINIUM_API_KEY and GAINIUM_API_SECRET for local stdio mode.",
    )
  }

  return new GainiumClient(BASE_URL, apiKey, apiSecret)
}

// ── OAuth protected-resource metadata + 401 challenge (RFC 9728) ───────────
function publicBaseUrl(req: IncomingMessage): string {
  if (MCP_PUBLIC_URL) {
    return MCP_PUBLIC_URL
  }
  const proto =
    getHeaderValue(req.headers['x-forwarded-proto'])?.split(',')[0]?.trim() ||
    'http'
  const host = req.headers.host || `${HTTP_HOST}:${HTTP_PORT}`
  return `${proto}://${host}`
}

function resourceMetadataPath(): string {
  // RFC 9728 path-insertion for a resource that has a path component.
  return `/.well-known/oauth-protected-resource${MCP_HTTP_PATH}`
}

function resourceMetadataUrl(req: IncomingMessage): string {
  return `${publicBaseUrl(req)}${resourceMetadataPath()}`
}

function resourceMetadataDoc(req: IncomingMessage): Record<string, unknown> {
  const base = publicBaseUrl(req)
  return {
    resource: `${base}${MCP_HTTP_PATH}`,
    authorization_servers: [OAUTH_ISSUER],
    // Read-only connector advertises only the read scope so clients request it
    // and the consent screen need not offer write.
    scopes_supported:
      process.env.GAINIUM_READONLY === 'true' ? ['read'] : ['read', 'write'],
    bearer_methods_supported: ['header'],
  }
}

function writeUnauthorized(res: ServerResponse, req: IncomingMessage): void {
  res.statusCode = 401
  res.setHeader(
    'WWW-Authenticate',
    `Bearer resource_metadata="${resourceMetadataUrl(req)}"`,
  )
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(
    JSON.stringify({
      error: 'invalid_token',
      error_description: 'Missing or invalid OAuth access token',
    }),
  )
}

// Returns true if the request is authenticated (or OAuth is disabled).
// Otherwise it has already written a 401 challenge and the caller should stop.
async function ensureAuthorized(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!OAUTH_ENABLED) {
    return true
  }
  const token = extractBearer(req.headers['authorization'])
  if (!token) {
    writeUnauthorized(res, req)
    return false
  }
  const intro = await introspectToken(token)
  if (!intro.active || !audienceAllowed(intro)) {
    writeUnauthorized(res, req)
    return false
  }
  return true
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []

  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }

  if (chunks.length === 0) {
    return undefined
  }

  const rawBody = Buffer.concat(chunks).toString('utf8').trim()
  if (!rawBody) {
    return undefined
  }

  try {
    return JSON.parse(rawBody)
  } catch {
    throw new Error('Request body must be valid JSON')
  }
}

function writeTextResponse(
  res: ServerResponse,
  statusCode: number,
  message: string,
): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end(message)
}

function writeJsonRpcError(
  res: ServerResponse,
  statusCode: number,
  message: string,
  code = -32000,
): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code, message },
      id: null,
    }),
  )
}

function writeMethodNotAllowed(
  res: ServerResponse,
  allowedMethods: string[],
): void {
  res.statusCode = 405
  res.setHeader('Allow', allowedMethods.join(', '))
  res.end('Method Not Allowed')
}

function paperHeader(args: Record<string, any>): Record<string, string> {
  const headers: Record<string, string> = {}
  if (args.paperContext !== undefined && args.paperContext !== null) {
    headers['paper-context'] = String(args.paperContext)
  }
  return headers
}

// Take-profit value fields. TP only fires when dealCloseCondition === "tp".
const TP_VALUE_FIELDS = [
  'tpPerc',
  'useMultiTp',
  'multiTp',
  'trailingTp',
  'trailingTpPerc',
  'useMinTP',
  'minTp',
  'useFixedTPPrices',
  'fixedTpPrice',
]

// Pure client-side sort key functions for get_screener. The screener API ignores
// sort/order server-side, so we sort the fetched coins by these keys. Exported for
// unit testing (the resolution + ordering logic is pure; only the fetch is networked).
export const SCREENER_SORT_KEYS: Record<string, (c: any) => number> = {
  volatility: (c) => Math.abs(Number(c.priceChangePercentage24h) || 0),
  pricechangepercentage24h: (c) => Number(c.priceChangePercentage24h) || 0,
  pricechange: (c) => Number(c.priceChangePercentage24h) || 0,
  change: (c) => Number(c.priceChangePercentage24h) || 0,
  totalvolume: (c) => Number(c.totalVolume) || 0,
  volume: (c) => Number(c.totalVolume) || 0,
  marketcap: (c) => Number(c.marketCap) || 0,
  currentprice: (c) => Number(c.currentPrice) || 0,
  price: (c) => Number(c.currentPrice) || 0,
}

// Runtime/computed fields carried in a stored preset's settings blob that the
// bot-create endpoint rejects as input.
const PRESET_STRIP_FIELDS = [
  '_id',
  'type',
  'changed',
  'hodlNextBuy',
  'hodlAt',
  'hodlDay',
  'hodlHourly',
  'activeOrdersCount',
  'avgPrice',
  'baseOrderPrice',
  'slChangedByUser',
  'importFrom',
]

// Quote assets used to split a normalised pair (e.g. "BTCUSDT") back into the
// underscore input format ("BTC_USDT"). Longest-first so USDT matches before USD.
const KNOWN_QUOTE_ASSETS = [
  'USDT',
  'USDC',
  'FDUSD',
  'TUSD',
  'BUSD',
  'DAI',
  'USD',
  'BTC',
  'ETH',
  'BNB',
  'EUR',
  'TRY',
  'BRL',
]

function toUnderscorePair(pair: unknown, _coin?: string): string | undefined {
  if (typeof pair !== 'string' || !pair) return undefined
  const clean = pair.replace(/[-_/]/g, '').toUpperCase()
  for (const q of KNOWN_QUOTE_ASSETS) {
    if (clean.length > q.length && clean.endsWith(q)) {
      return `${clean.slice(0, clean.length - q.length)}_${q}`
    }
  }
  return pair
}

// Inject safe defaults so feature values are not silently ignored by the API.
// Mutates `settings` in place; returns human-readable notes for what was injected.
export function applySettingsSafeDefaults(
  settings: Record<string, any>,
  kind: 'deal' | 'bot',
): string[] {
  const notes: string[] = []
  if (!settings || typeof settings !== 'object') return notes

  // A deal/bot only takes profit when its close condition is "tp". Deals opened in
  // the Gainium UI can sit on "manual", which silently ignores tpPerc. When the caller
  // is configuring TP (useTp:true + a TP value) but didn't pin the close condition,
  // default it to "tp" so the take-profit actually fires. Scoped to deals because the
  // API rejects regressing a deal to "manual" (so this is near-idempotent), whereas a
  // bot may intentionally close by techInd/webhook.
  if (kind === 'deal') {
    const settingTp =
      settings.useTp === true && TP_VALUE_FIELDS.some((f) => f in settings)
    if (settingTp && !('dealCloseCondition' in settings)) {
      settings.dealCloseCondition = 'tp'
      notes.push(
        'Set dealCloseCondition="tp" so the take-profit actually fires — it is silently ignored while a deal closes by "manual". Pass dealCloseCondition explicitly to override.',
      )
    }
  }

  // Multi-TP / multi-SL items require a unique `uuid` per target alongside
  // {target, amount}. Auto-generate any missing uuids so callers can pass just
  // {target, amount}. (The API rejects items without a uuid.)
  for (const field of ['multiTp', 'multiSl'] as const) {
    const arr = settings[field]
    if (!Array.isArray(arr)) continue
    let injected = 0
    for (const item of arr) {
      if (item && typeof item === 'object' && !item.uuid) {
        item.uuid = randomUUID()
        injected++
      }
    }
    if (injected > 0) {
      notes.push(
        `Generated uuid for ${injected} ${field} item(s) — each target needs a unique id.`,
      )
    }
  }
  return notes
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a != null && b != null && String(a) === String(b)) return true
  return false
}

// Read settings back after a write and report any SCALAR key whose stored value does
// not match what we sent — i.e. fields the API silently ignored. Best-effort: never
// throws, and skips arrays/objects (pairs are normalized, multiTp shapes vary).
async function verifySettingsApplied(
  client: GainiumClient,
  kind: 'deal' | 'bot',
  type: string,
  id: string,
  sent: Record<string, any>,
  args: Record<string, any>,
): Promise<string[]> {
  try {
    // Updates are applied asynchronously ("Settings update scheduled").
    await new Promise((r) => setTimeout(r, 2000))
    const path =
      kind === 'deal'
        ? `/api/v2/deals/${type}/details`
        : `/api/v2/bots/${type}/details`
    const idKey = kind === 'deal' ? 'dealId' : 'botId'
    const res: any = await client.request('GET', path, {
      query: { [idKey]: id, fields: 'full' },
      headers: paperHeader(args),
    })
    const stored: Record<string, any> = res?.data?.settings ?? res?.data ?? {}
    const mismatches: string[] = []
    for (const [k, v] of Object.entries(sent)) {
      if (k === 'changed') continue
      if (v === null || typeof v === 'object') continue // skip normalized arrays/objects
      if (!(k in stored)) continue // not every sent key is echoed back
      if (!looseEqual(stored[k], v)) {
        mismatches.push(
          `${k}: sent ${JSON.stringify(v)} but stored ${JSON.stringify(stored[k])}`,
        )
      }
    }
    return mismatches
  } catch {
    return [] // verification is best-effort; don't fail the write on read-back error
  }
}

// Attach safe-default notes and write-verification result to a write response.
function decorateWriteResult(
  res: unknown,
  defaults: string[],
  mismatches: string[],
): Record<string, any> {
  const out: Record<string, any> =
    res && typeof res === 'object' ? { ...(res as object) } : { data: res }
  if (defaults.length) out._appliedDefaults = defaults
  out._verification =
    mismatches.length > 0
      ? {
          status: 'MISMATCH',
          note: 'These fields were NOT applied by the API (silently ignored) — check feature toggles / close condition:',
          mismatches,
        }
      : {
          status: 'OK',
          note: 'Read-back confirmed the changed fields were applied.',
        }
  return out
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasKeys(value: unknown): value is Record<string, any> {
  return isPlainObject(value) && Object.keys(value).length > 0
}

// ── Guards & Validation ──────────────────────────────────────────────────────

const BOT_FILTER_LIST_TOOLS = new Set(['list_bots', 'list_deals'])

function enforceGuards(args: Record<string, any>): void {
  const toolName = args.__toolName

  if (ALLOWED_BOT_ID) {
    if (BOT_FILTER_LIST_TOOLS.has(toolName)) {
      args.botId = ALLOWED_BOT_ID
    } else if (
      args.botId !== undefined &&
      args.botId !== null &&
      args.botId !== ALLOWED_BOT_ID
    ) {
      throw new Error(
        `Bot ID '${args.botId}' is not allowed. This instance is restricted to bot '${ALLOWED_BOT_ID}'.`,
      )
    }
  }

  if (PAPER_ONLY) {
    if (args.paperContext === false) {
      throw new Error(
        'Live trading is disabled. This instance is restricted to paper trading only. Set paperContext to true or omit it.',
      )
    }

    if (args.paperContext === undefined || args.paperContext === null) {
      args.paperContext = true
    }
  }
}

export function validateBacktestPayloadShape(args: Record<string, any>): void {
  if (!hasKeys(args.payload)) {
    throw new Error(
      "Missing required top-level field 'payload'. Expected shape: { payload: { data: { exchange, exchangeUUID, settings, from?, to?, interval? } } }" +
        '\nRecovery: {"missingField":"payload","suggestedTools":["build_backtest_payload_template","get_backtest_operation_schema"]}',
    )
  }

  if (!hasKeys(args.payload.data)) {
    throw new Error(
      "Missing required object 'payload.data'. Place bot settings under 'payload.data.settings'. " +
        'Expected shape: { payload: { data: { exchange: string, exchangeUUID: string, settings: { ... }, from?: number, to?: number, interval?: string } } }' +
        '\nRecovery: {"missingObject":"payload.data","suggestedTools":["build_backtest_payload_template"]}',
    )
  }

  if (!isNonEmptyString(args.payload.data.exchange)) {
    throw new Error(
      'Missing \'payload.data.exchange\'. Provide the exchange code string, e.g. "binance" or "okxLinear". ' +
        'Use discover(target: "supportedExchanges") to list valid codes, or get_account(info: "exchanges") to see your connected exchanges.' +
        '\nRecovery: {"missingField":"payload.data.exchange","suggestedTools":["discover","get_account"]}',
    )
  }

  if (!isNonEmptyString(args.payload.data.exchangeUUID)) {
    throw new Error(
      "Missing 'payload.data.exchangeUUID'. Use get_account(info: 'exchanges') to retrieve the UUID for your exchange connection." +
        '\nRecovery: {"missingField":"payload.data.exchangeUUID","suggestedTools":["get_account"]}',
    )
  }

  if (!hasKeys(args.payload.data.settings)) {
    throw new Error(
      "Missing required object 'payload.data.settings'. Use discover(target: 'bot', botType) to learn valid settings fields, " +
        'or call build_backtest_payload_template(botType) to get a ready-to-fill scaffold.' +
        '\nRecovery: {"missingObject":"payload.data.settings","suggestedTools":["discover","build_backtest_payload_template"]}',
    )
  }
}

export function validateToolArgs(
  name: string,
  args: Record<string, any>,
): void {
  // ── Common discriminator validation ──

  const validBotTypes = ['dca', 'combo', 'grid']
  const validBotTypesReadOnly = ['dca', 'combo', 'grid']
  const validDealTypes = ['dca', 'combo', 'terminal']

  // Tools that require botType (read-only — list and get support hedge types)
  if (['list_bots', 'get_bot'].includes(name)) {
    if (!isNonEmptyString(args.botType)) {
      throw new Error(
        `'botType' is required. Must be one of: ${validBotTypesReadOnly.join(', ')}`,
      )
    }
    if (!validBotTypesReadOnly.includes(args.botType)) {
      throw new Error(
        `Invalid botType '${args.botType}'. Must be one of: ${validBotTypesReadOnly.join(', ')}`,
      )
    }
  }

  // Tools that require botType (write operations — hedge types not supported)
  if (['create_bot', 'update_bot', 'clone_bot'].includes(name)) {
    if (!isNonEmptyString(args.botType)) {
      throw new Error(
        `'botType' is required. Must be one of: ${validBotTypes.join(', ')}`,
      )
    }
    if (!validBotTypes.includes(args.botType)) {
      throw new Error(
        `Invalid botType '${args.botType}'. Must be one of: ${validBotTypes.join(', ')}`,
      )
    }
  }

  // Tools that require dealType
  if (['list_deals', 'get_deal', 'update_deal'].includes(name)) {
    if (!isNonEmptyString(args.dealType)) {
      throw new Error(
        `'dealType' is required. Must be one of: ${validDealTypes.join(', ')}`,
      )
    }
    if (!validDealTypes.includes(args.dealType)) {
      throw new Error(
        `Invalid dealType '${args.dealType}'. Must be one of: ${validDealTypes.join(', ')}`,
      )
    }
  }

  // Tools that require specific IDs
  if (['get_bot', 'update_bot', 'clone_bot'].includes(name)) {
    if (!isNonEmptyString(args.botId)) {
      throw new Error("'botId' is required")
    }
  }

  if (['get_deal', 'update_deal'].includes(name)) {
    if (!isNonEmptyString(args.dealId)) {
      throw new Error("'dealId' is required")
    }
  }

  // get_account requires info discriminator
  if (name === 'get_account') {
    const validInfoValues = [
      'balances',
      'exchanges',
      'globalVariables',
      'supportedExchanges',
    ]
    if (!isNonEmptyString(args.info)) {
      throw new Error(
        `'info' is required. Must be one of: ${validInfoValues.join(', ')}`,
      )
    }
    if (!validInfoValues.includes(args.info)) {
      throw new Error(
        `Invalid info '${args.info}'. Must be one of: ${validInfoValues.join(', ')}`,
      )
    }
  }

  // update_bot: grid bots have no update endpoint
  if (name === 'update_bot' && args.botType === 'grid') {
    throw new Error(
      'Grid bots do not have an update endpoint. To modify a grid bot, stop it and create a new one.',
    )
  }

  // ── update_bot & update_deal validation ──
  if (['update_bot', 'update_deal'].includes(name)) {
    if (!hasKeys(args.settings)) {
      throw new Error("'settings' must be a non-empty object")
    }

    // Boolean-gate enforcement: value fields are silently ignored by the API
    // unless their feature toggle is explicitly set to true in the SAME call.
    const s = args.settings as Record<string, any>
    const gateViolations: string[] = []

    const dcaValueFields = [
      'ordersCount',
      'orderSize',
      'step',
      'volumeScale',
      'stepScale',
      'dcaCondition',
      'dcaCustom',
      'dcaVolumeBaseOn',
      'dcaVolumeRequiredChange',
      'dcaVolumeMaxValue',
    ]
    if (dcaValueFields.some((f) => f in s) && s.useDca !== true) {
      gateViolations.push(
        `You are setting DCA order fields (${dcaValueFields.filter((f) => f in s).join(', ')}) but 'useDca' is not true in the same settings object. ` +
          'The API will silently ignore these fields unless useDca is explicitly enabled. ' +
          'Add "useDca": true to settings, or set "useDca": false if you intentionally want to disable DCA.',
      )
    }

    // useTp gates: tpPerc, useMultiTp/multiTp sub-tree, trailingTp/trailingTpPerc sub-tree
    const tpValueFields = [
      'tpPerc',
      'useMultiTp',
      'multiTp',
      'trailingTp',
      'trailingTpPerc',
      'useMinTP',
      'minTp',
      'useFixedTPPrices',
      'fixedTpPrice',
    ]
    if (tpValueFields.some((f) => f in s) && s.useTp !== true) {
      gateViolations.push(
        `You are setting take-profit fields (${tpValueFields.filter((f) => f in s).join(', ')}) but 'useTp' is not true in the same settings object. ` +
          'Add "useTp": true to settings.',
      )
    }

    // trailingTp (sub-toggle under useTp) gates trailingTpPerc
    if ('trailingTpPerc' in s && s.trailingTp !== true) {
      gateViolations.push(
        "You are setting 'trailingTpPerc' but 'trailingTp' is not true. Add \"trailingTp\": true to settings.",
      )
    }

    // useMultiTp gates multiTp array
    if ('multiTp' in s && s.useMultiTp !== true) {
      gateViolations.push(
        "You are setting 'multiTp' but 'useMultiTp' is not true. Add \"useMultiTp\": true to settings.",
      )
    }

    // useSl gates: slPerc, trailingSl, useMultiSl/multiSl sub-tree
    const slValueFields = [
      'slPerc',
      'trailingSl',
      'useMultiSl',
      'multiSl',
      'useFixedSLPrices',
      'fixedSlPrice',
    ]
    if (slValueFields.some((f) => f in s) && s.useSl !== true) {
      gateViolations.push(
        `You are setting stop-loss fields (${slValueFields.filter((f) => f in s).join(', ')}) but 'useSl' is not true in the same settings object. ` +
          'Add "useSl": true to settings.',
      )
    }

    // useMultiSl gates multiSl array
    if ('multiSl' in s && s.useMultiSl !== true) {
      gateViolations.push(
        "You are setting 'multiSl' but 'useMultiSl' is not true. Add \"useMultiSl\": true to settings.",
      )
    }

    // moveSL gates moveSLTrigger, moveSLValue, moveSLForAll
    const moveSLValueFields = ['moveSLTrigger', 'moveSLValue', 'moveSLForAll']
    if (moveSLValueFields.some((f) => f in s) && s.moveSL !== true) {
      gateViolations.push(
        `You are setting trailing SL fields (${moveSLValueFields.filter((f) => f in s).join(', ')}) but 'moveSL' is not true in the same settings object. ` +
          'Add "moveSL": true to settings.',
      )
    }

    // closeByTimer gates closeByTimerValue, closeByTimerUnits
    const closeByTimerValueFields = ['closeByTimerValue', 'closeByTimerUnits']
    if (
      closeByTimerValueFields.some((f) => f in s) &&
      s.closeByTimer !== true
    ) {
      gateViolations.push(
        `You are setting close-by-timer fields (${closeByTimerValueFields.filter((f) => f in s).join(', ')}) but 'closeByTimer' is not true. ` +
          'Add "closeByTimer": true to settings.',
      )
    }

    if (gateViolations.length > 0) {
      throw new Error(
        'Boolean gate violation — feature values will be silently ignored by the API:\n' +
          gateViolations.map((v, i) => `${i + 1}. ${v}`).join('\n'),
      )
    }
  }

  // ── clone_bot validation ──
  if (name === 'clone_bot') {
    if (!isNonEmptyString(args.botId)) {
      throw new Error("'botId' is required")
    }
    if (args.overrides !== undefined && !isPlainObject(args.overrides)) {
      throw new Error("'overrides' must be an object when provided")
    }
  }

  // ── manage_bot validation ──
  if (name === 'manage_bot') {
    if (!isNonEmptyString(args.action)) {
      throw new Error("'action' is required")
    }
    if (!isNonEmptyString(args.botId)) {
      throw new Error("'botId' is required")
    }
    if (!isNonEmptyString(args.botType)) {
      throw new Error("'botType' is required")
    }

    const action = args.action
    if (action === 'stop') {
      const isGrid = args.botType === 'grid'
      if (!isGrid) {
        const validCloseTypes = [
          'leave',
          'closeByMarket',
          'closeByLimit',
          'cancel',
        ]
        if (!isNonEmptyString(args.closeType)) {
          throw new Error(
            "'closeType' is required for stop action (dca/combo). " +
              'Decide intent: "closeByMarket" to close all active deals immediately, ' +
              '"leave" to pause the bot and keep deals open, "cancel" to cancel orders only.',
          )
        }
        if (!validCloseTypes.includes(args.closeType)) {
          throw new Error(
            `'closeType' must be one of: ${validCloseTypes.join(', ')}. Got: "${args.closeType}"`,
          )
        }
      } else {
        const validGridTypes = ['cancel', 'closeByMarket', 'closeByLimit']
        if (!isNonEmptyString(args.closeGridType)) {
          throw new Error(
            "'closeGridType' is required for stop action (grid). " +
              'Choose: "cancel" to cancel grid orders, "closeByMarket" to close position at market.',
          )
        }
        if (!validGridTypes.includes(args.closeGridType)) {
          throw new Error(
            `'closeGridType' must be one of: ${validGridTypes.join(', ')}. Got: "${args.closeGridType}"`,
          )
        }
      }
    }

    if (action === 'changePairs') {
      if (args.botType !== 'dca') {
        throw new Error("'changePairs' action is only supported for dca bots")
      }
      if (!Array.isArray(args.pair) || args.pair.length === 0) {
        throw new Error("'pair' must be a non-empty array")
      }
    }
  }

  // ── create_deal validation ──
  if (name === 'create_deal') {
    if (!isNonEmptyString(args.dealType)) {
      throw new Error("'dealType' is required")
    }

    const dealType = args.dealType
    if (dealType === 'terminal') {
      if (!isNonEmptyString(args.exchangeUUID)) {
        throw new Error("'exchangeUUID' is required for terminal deals")
      }
      if (!isNonEmptyString(args.terminalDealType)) {
        throw new Error("'terminalDealType' is required for terminal deals")
      }
    } else if (dealType === 'dca' || dealType === 'combo') {
      if (!isNonEmptyString(args.botId)) {
        throw new Error("'botId' is required for dca/combo deals")
      }
    }
  }

  // ── manage_deal validation ──
  if (name === 'manage_deal') {
    if (!isNonEmptyString(args.action)) {
      throw new Error("'action' is required")
    }
    if (!isNonEmptyString(args.dealId)) {
      throw new Error("'dealId' is required")
    }
    if (!isNonEmptyString(args.dealType)) {
      throw new Error("'dealType' is required")
    }

    const action = args.action
    if (action === 'close') {
      if (!isNonEmptyString(args.closeType)) {
        throw new Error("'closeType' is required for close action")
      }
    } else if (action === 'addFunds' || action === 'reduceFunds') {
      if (!isNonEmptyString(args.qty)) {
        throw new Error("'qty' is required for addFunds/reduceFunds")
      }
      const fundsType = isNonEmptyString(args.type) ? args.type : 'fixed'
      if (fundsType === 'fixed' && !isNonEmptyString(args.asset)) {
        throw new Error("'asset' is required when type is 'fixed'")
      }
    }
  }

  // ── run_backtest validation ──
  if (name === 'run_backtest') {
    const validModes = ['validate', 'estimate', 'request', 'requestSync']
    if (!isNonEmptyString(args.mode)) {
      throw new Error(
        `'mode' is required. Must be one of: ${validModes.join(', ')}`,
      )
    }
    if (!validModes.includes(args.mode)) {
      throw new Error(
        `Invalid mode '${args.mode}'. Must be one of: ${validModes.join(', ')}`,
      )
    }
    if (!isNonEmptyString(args.botType)) {
      throw new Error("'botType' is required")
    }
    validateBacktestPayloadShape(args)
  }

  // ── backtest_info validation ──
  if (name === 'backtest_info') {
    if (!isNonEmptyString(args.target)) {
      throw new Error("'target' is required")
    }
    if (!isNonEmptyString(args.botType)) {
      throw new Error("'botType' is required")
    }
    if (args.target === 'request' && !isNonEmptyString(args.id)) {
      throw new Error("'id' is required for target='request'")
    }
  }

  // ── discover validation ──
  if (name === 'discover') {
    if (!isNonEmptyString(args.target)) {
      throw new Error("'target' is required")
    }
    const target = args.target
    if (
      (target === 'bot' || target === 'botSections') &&
      !isNonEmptyString(args.botType)
    ) {
      throw new Error(`'botType' is required for target='${target}'`)
    }
    if (target === 'indicator' && !isNonEmptyString(args.type)) {
      throw new Error("'type' is required for target='indicator'")
    }
  }

  // ── manage_global_variable validation ──
  if (name === 'manage_global_variable') {
    if (!isNonEmptyString(args.action)) {
      throw new Error("'action' is required")
    }
    const action = args.action
    if (action === 'create') {
      if (!isNonEmptyString(args.name)) {
        throw new Error("'name' is required for create action")
      }
      if (!isNonEmptyString(args.type)) {
        throw new Error("'type' is required for create action")
      }
      if (!isNonEmptyString(args.value)) {
        throw new Error("'value' is required for create action")
      }
    } else if (action === 'update' || action === 'delete') {
      if (!isNonEmptyString(args.id)) {
        throw new Error("'id' is required for update/delete actions")
      }
      if (
        action === 'update' &&
        args.name === undefined &&
        args.type === undefined &&
        args.value === undefined
      ) {
        throw new Error(
          "Provide at least one of: 'name', 'type', or 'value' for update",
        )
      }
    }
  }

  // ── get_account validation ──
  if (name === 'get_account') {
    if (args.info === 'balances') {
      if (isNonEmptyString(args.asset) && isNonEmptyString(args.assets)) {
        throw new Error("Use either 'asset' or 'assets', not both")
      }
    }
  }
}

// ── Shared schema fragments ─────────────────────────────────────────────────

const fieldsParam = {
  fields: {
    type: 'string' as const,
    description:
      'Field selection: preset ("minimal", "standard", "extended", "full") or comma-separated fields (e.g. "_id,uuid,settings.name,profit.total"). Default: "standard"',
  },
}

const pageParam = {
  page: {
    type: 'integer' as const,
    description: 'Page number for pagination (1-based). Default: 1',
  },
}

const botStatusParam = {
  status: {
    type: 'string' as const,
    enum: ['open', 'closed', 'range', 'error', 'archive', 'monitoring'],
    description: 'Filter by bot status',
  },
}

const dealStatusParam = {
  status: {
    type: 'string' as const,
    enum: ['open', 'closed', 'start', 'error', 'canceled'],
    description: 'Filter by deal status',
  },
}

const paperContextParam = {
  paperContext: {
    type: 'boolean' as const,
    description:
      'Paper trading context (true = paper, false = real). Default: false',
  },
}

const botIdRequired = {
  botId: {
    type: 'string' as const,
    description:
      'Bot identifier. Accepts EITHER the bot\'s 24-character hex MongoDB ObjectId ' +
      '(e.g. "65f000000000000000000001") OR the bot\'s UUID ' +
      '(e.g. "550e8400-e29b-41d4-a716-446655440000"). Either form resolves to the same bot — ' +
      'use whichever the bot record exposes. Get both from list_bots (the `_id` and `uuid` fields).',
  },
}

const dealIdRequired = {
  dealId: {
    type: 'string' as const,
    description:
      'Deal identifier. Accepts EITHER the deal\'s 24-character hex MongoDB ObjectId ' +
      '(e.g. "65f000000000000000000001") OR the deal\'s UUID. Either form resolves to the same deal — ' +
      'use whichever the deal record exposes. Get both from list_deals (the `_id` and `uuid` fields).',
  },
}

export const backtestPayloadParam = {
  payload: {
    type: 'object' as const,
    required: ['data'],
    properties: {
      data: {
        type: 'object' as const,
        required: ['exchange', 'exchangeUUID', 'settings'],
        properties: {
          exchange: {
            type: 'string' as const,
            description:
              'Exchange code string, e.g. "binance", "okxLinear". Use discover(target: "supportedExchanges") to list all codes, or get_account(info: "exchanges") to see your connected accounts.',
          },
          exchangeUUID: {
            type: 'string' as const,
            description:
              'Exchange connection UUID. Use get_account(info: "exchanges") to retrieve.',
          },
          settings: {
            type: 'object' as const,
            description:
              'Inner bot settings object. Use discover(target: "bot", botType) to learn valid fields, or call build_backtest_payload_template(botType) for a prefilled scaffold.',
          },
          from: {
            type: 'number' as const,
            description:
              'Range start as Unix millisecond timestamp. Optional for validate.',
          },
          to: {
            type: 'number' as const,
            description:
              'Range end as Unix millisecond timestamp. Optional for validate.',
          },
          interval: {
            type: 'string' as const,
            enum: ['1m', '5m', '15m', '1h', '4h', '1d'],
            description: 'Candle interval. Optional, default: 1h.',
          },
        },
        description: 'Backtest data wrapper.',
      },
    },
    description:
      'Backtest request wrapper. Required nesting: payload.data.exchange (string), payload.data.exchangeUUID (UUID string), payload.data.settings (inner bot settings object). Optional: from, to (Unix ms timestamps), interval (default: 1h).',
  },
}

// ── Agent workflow resource ─────────────────────────────────────────────────

export const WORKFLOW_RESOURCE_URI = 'gainium://workflow'
export const WORKFLOW_RESOURCE_TEXT = `
Gainium MCP — canonical agent workflow
=======================================

## Layer model
Discovery outputs describe the INNER settings object.
Each operation has a different OUTER envelope:

  Layer 1 — discovery:           discover(target: "bot", botType) → { sections: [{ fields: [...] }] }
  Layer 2 — bot create/update:   { exchangeUUID, pair, ...settingsFields (flat) }
  Layer 3 — backtest body:       { payload: { data: { exchange, exchangeUUID, settings: <Layer 1 fields>, from, to, interval } } }

## Recommended flows

### Backtest a strategy
1. get_account(info: "exchanges")           → pick exchangeUUID + exchange id
2. discover(target: "botSections", botType) → discover available settings sections
3. discover(target: "bot", botType, section) → learn field names and defaults
4. build_backtest_payload_template(botType) → get a ready-to-fill scaffold
5. run_backtest(mode: "validate")           → confirm payload before spending credits
6. run_backtest(mode: "estimate")           → check credit cost
7. run_backtest(mode: "requestSync")        → run backtest and get result
   (or run_backtest(mode: "request") + backtest_info(target: "request") for async polling)

### DECISION RULE — stop bot vs close individual deals
DO NOT close deals one by one when the goal is to stop a bot.
USE manage_bot(action: "stop") with the correct closeType for the bot's type instead:
  - "close bot by market" / "stop and sell" / "close all positions" → manage_bot(action: "stop", botId, botType, closeType="closeByMarket")
  - "pause bot" / "stop new deals" / "stop without closing"        → manage_bot(action: "stop", botId, botType, closeType="leave")
  - grid bot close                                                   → manage_bot(action: "stop", botId, botType="grid", closeGridType="closeByMarket")
manage_bot(action: "stop", closeType="closeByMarket") closes ALL active deals AND stops the bot in ONE call.
manage_deal(action: "close") is ONLY for closing a single specific deal while leaving the bot running.

### Create and manage a bot
1. get_account(info: "exchanges")           → pick exchangeUUID
2. discover(target: "bot", botType)         → learn valid settings fields and defaults
3. create_bot(botType)
   - Pass common fields as top-level params (name, strategy, baseOrderSize, tpPerc, etc.)
   - Pass ANY additional discovery field (startOrderType, useDca, useSl, moveSL, moveSLTrigger,
     moveSLValue, useMoveTP, dcaOrdersMultiplier, indicators, timers, etc.) in the 'settings'
     object — it is merged flat into the body at creation time. No create→update two-step needed.
4. manage_bot(action: "start"); to STOP a bot use manage_bot(action: "stop") — see DECISION RULE above.

### Inspect deals
1. list_deals(dealType)
   - pass botId = MongoDB _id from list_bots (NOT the exchangeUUID) to filter by bot
   - returns dealId for each deal
2. get_deal(dealType, dealId)                      → full detail
3. manage_deal(action: "close", dealId, dealType) — use ONLY to close a single specific deal while the bot keeps running.
   DO NOT use manage_deal in a loop to stop a bot — use manage_bot(action: "stop", closeType="closeByMarket") instead.
4. update_deal(dealType, dealId)                   → pass dealId + settings object with only changed fields

## Terminology
- exchange     = exchange code string, e.g. "binance", "okxLinear"
- exchangeUUID = UUID from get_account(info: "exchanges"); required for all write operations
- pair         = always {base}_{quote} with underscore, e.g. "BTC_USDT" (NOT exchange-native "BTCUSDT").
               create_bot accepts: dca/combo: array ["BTC_USDT"], grid: single string "BTC_USDT"
               Server normalizes to exchange-native format internally — always use underscore format in MCP tools.
- settings     = inner bot config object (from discovery)
- payload      = outer backtest envelope: { data: { exchange, exchangeUUID, settings, from?, to?, interval? } }
- boolean gates = most features require a boolean toggle to be enabled alongside value fields, otherwise values are silently ignored.
               Examples: useDca:true (gates ordersCount/orderSize/step/volumeScale/stepScale/dcaCondition),
               useTp:true (gates tpPerc/trailingTp/trailingTpPerc/useMultiTp/multiTp/useMinTP/minTp),
               useSl:true (gates slPerc/trailingSl/useMultiSl/multiSl),
               moveSL:true (gates moveSLTrigger/moveSLValue/moveSLForAll),
               closeByTimer:true (gates closeByTimerValue/closeByTimerUnits).
               Always set the gate when changing feature values.
`.trim()

// ── Output schemas ──────────────────────────────────────────────────────────
// The read tools pass the Gainium API response straight through. That response
// is the envelope `{ status, reason, data, meta? }`, where `data` shape depends
// on the `fields` projection. Schemas are therefore intentionally permissive
// (additionalProperties allowed, nothing required) so field selection never
// produces output that violates the declared schema. They exist to tell models
// the top-level shape, not to pin every nested field.
type OutputSchema = Tool['outputSchema']

const META_OUTPUT = {
  type: 'object',
  description: 'Pagination / result metadata, present on list-style responses.',
  properties: {
    page: { type: 'number' },
    total: { type: 'number' },
    count: { type: 'number' },
    onPage: { type: 'number' },
    fields: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: true,
}

function envelopeOutput(data: object, description: string): OutputSchema {
  return {
    type: 'object',
    description,
    properties: {
      status: {
        type: 'string',
        enum: ['OK', 'NOTOK'],
        description: 'OK on success, NOTOK on a handled API error.',
      },
      reason: {
        type: ['string', 'null'],
        description: 'Error reason when status is NOTOK; null otherwise.',
      },
      data,
      meta: META_OUTPUT,
    },
    additionalProperties: true,
  } as OutputSchema
}

function genericObjectOutput(description: string): OutputSchema {
  return {
    type: 'object',
    description,
    additionalProperties: true,
  } as OutputSchema
}

const arrayData = (description: string) => ({
  type: 'array',
  description,
  items: { type: 'object', additionalProperties: true },
})
const objectData = (description: string) => ({
  type: 'object',
  description,
  additionalProperties: true,
})
// For payloads that may be an array or an object depending on the request
// (e.g. discovery / account variants) — leave the type unconstrained.
const anyData = (description: string) => ({ description })

// ── Tool Definitions ────────────────────────────────────────────────────────

export const tools: Tool[] = [
  // ─── Bots ───────────────────────────────────────────────────────────────

  {
    name: 'list_bots',
    annotations: { title: 'List Bots', readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    description:
      'List bots by type (DCA, Combo, or Grid). Supports field selection presets (minimal, standard, extended, full). Supports filtering by status and paper/real trading context.',
    inputSchema: {
      type: 'object',
      properties: {
        botType: {
          type: 'string',
          enum: ['dca', 'combo', 'grid'],
          description: 'Bot type',
        },
        ...fieldsParam,
        ...pageParam,
        ...botStatusParam,
        ...paperContextParam,
      },
      required: ['botType'],
    },
    outputSchema: envelopeOutput(
      arrayData('Matching bot records; fields present depend on the `fields` preset.'),
      'Gainium API envelope with the list of bots in `data`.',
    ),
  },

  {
    name: 'get_bot',
    annotations: { title: 'Get Bot', readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    description:
      'Get a single bot by its MongoDB ObjectId or UUID. Supports the same field selection presets as list_bots.',
    inputSchema: {
      type: 'object',
      properties: {
        botType: {
          type: 'string',
          enum: ['dca', 'combo', 'grid'],
          description: 'Bot type',
        },
        ...botIdRequired,
        ...fieldsParam,
        ...paperContextParam,
      },
      required: ['botType', 'botId'],
    },
    outputSchema: envelopeOutput(
      objectData('The bot record; fields present depend on the `fields` preset.'),
      'Gainium API envelope with the bot in `data`.',
    ),
  },

  {
    name: 'create_bot',
    annotations: { title: 'Create Bot', readOnlyHint: false, destructiveHint: true },
    description:
      'Create a new bot in a single step — no follow-up update needed. ' +
      'The top-level properties cover the most common fields. For any field from discover(target: "bot") that is NOT listed here (e.g. startOrderType, useMoveTP, moveTPTrigger, moveTPValue, stopLossTimeout, takeProfitTimeout, dcaOrdersMultiplier, dcaStepMultiplier, trailingTP, trailingTPPerc, indicators, timers, and any other discovery field), ' +
      "pass them inside the 'settings' object — it is transparently merged into the request body at creation time. This avoids a create→update two-step. " +
      "Use discover(target: 'bot', botType) to discover all available fields and defaults. " +
      "The 'futures' and 'coinm' fields are auto-detected from the exchange — do not provide them. Requires write API key permission.",
    inputSchema: {
      type: 'object',
      properties: {
        botType: {
          type: 'string',
          enum: ['dca', 'combo', 'grid'],
          description: 'Bot type',
        },
        exchangeUUID: {
          type: 'string',
          description: 'UUID of the exchange connection to use',
        },
        ...paperContextParam,
        pair: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Trading pairs as array of {base}_{quote} strings, e.g. ["BTC_USDT"]. For Grid bots pass a single-element array — the server unwraps it automatically.',
        },
        name: { type: 'string', description: 'Bot name' },
        strategy: {
          type: 'string',
          enum: ['LONG', 'SHORT'],
          description: 'Trading direction. Default: LONG',
        },
        baseOrderSize: {
          type: 'string',
          description: 'Size of the initial base order, e.g. "100"',
        },
        orderSize: {
          type: 'string',
          description: 'Size of each DCA/grid order, e.g. "100"',
        },
        orderSizeType: {
          type: 'string',
          enum: ['base', 'quote', 'percFree', 'percTotal', 'usd'],
          description: 'Order size reference currency. Default: quote',
        },
        tpPerc: {
          type: 'string',
          description: 'Take profit percentage, e.g. "1.5"',
        },
        slPerc: {
          type: 'string',
          description: 'Stop loss percentage, e.g. "-10"',
        },
        step: {
          type: 'string',
          description: 'Price deviation % for next DCA/grid order, e.g. "1.5"',
        },
        ordersCount: {
          type: 'integer',
          description: 'Maximum number of orders (DCA/Combo)',
        },
        gridLevel: {
          type: 'string',
          description: 'Grid level count (Combo only)',
        },
        maxNumberOfOpenDeals: {
          type: 'string',
          description: 'Maximum concurrent open deals, e.g. "1"',
        },
        topPrice: {
          type: 'number',
          description: 'Top price for grid range (Grid only)',
        },
        lowPrice: {
          type: 'number',
          description: 'Low price for grid range (Grid only)',
        },
        budget: {
          type: 'number',
          description: 'Total budget for grid (Grid only)',
        },
        levels: {
          type: 'integer',
          description: 'Number of grid levels (Grid only)',
        },
        gridType: {
          type: 'string',
          enum: ['arithmetic', 'geometric'],
          description: 'Grid distribution type (Grid only)',
        },
        startCondition: {
          type: 'string',
          enum: [
            'ASAP',
            'Manual',
            'TradingviewSignals',
            'Timer',
            'TechnicalIndicators',
          ],
          description: 'Condition to start a new deal. Default: ASAP',
        },
        useDca: {
          type: 'boolean',
          description:
            'Enable DCA orders. Set false for a single base-order bot.',
        },
        useSl: {
          type: 'boolean',
          description: 'Enable stop-loss. When true, slPerc is used.',
        },
        moveSL: {
          type: 'boolean',
          description:
            'Enable trailing stop-loss (move SL as price moves in your favour).',
        },
        moveSLTrigger: {
          type: 'string',
          description: 'Profit % at which trailing SL is activated, e.g. "1.0"',
        },
        moveSLValue: {
          type: 'string',
          description: 'Trail distance % for the moving SL, e.g. "0.5"',
        },
        startOrderType: {
          type: 'string',
          enum: ['market', 'limit'],
          description: 'Order type for the base (start) order. Default: market',
        },
        settings: {
          type: 'object',
          description:
            'Transparent passthrough for any bot settings field from discover(target: "bot") that is not listed as a top-level property above. All keys are merged flat into the request body — use this to create a fully-configured bot in a single call.',
        },
      },
      required: ['botType', 'exchangeUUID', 'pair'],
    },
  },

  {
    name: 'update_bot',
    annotations: { title: 'Update Bot', readOnlyHint: false, destructiveHint: true },
    description:
      'Update an existing bot (DCA or Combo only; Grid has no update endpoint). Pass only the fields you want to change. Settings object must be non-empty. Boolean gate enforcement: feature value fields are silently ignored unless their toggle is set to true.',
    inputSchema: {
      type: 'object',
      properties: {
        botType: {
          type: 'string',
          enum: ['dca', 'combo'],
          description: 'Bot type (Grid does not support updates)',
        },
        ...botIdRequired,
        ...paperContextParam,
        settings: {
          type: 'object',
          minProperties: 1,
          description:
            'Settings object with fields to update. Only include changed fields.',
        },
      },
      required: ['botType', 'botId', 'settings'],
    },
  },

  {
    name: 'clone_bot',
    annotations: { title: 'Clone Bot', readOnlyHint: false, destructiveHint: true },
    description:
      'Clone an existing bot and optionally override settings. Returns the new bot ID.',
    inputSchema: {
      type: 'object',
      properties: {
        botType: {
          type: 'string',
          enum: ['dca', 'combo', 'grid'],
          description: 'Bot type',
        },
        ...botIdRequired,
        ...paperContextParam,
        overrides: {
          type: 'object',
          description:
            'Optional settings to override in the cloned bot. Pass an object with fields to change.',
        },
      },
      required: ['botType', 'botId'],
    },
  },

  {
    name: 'manage_bot',
    annotations: { title: 'Manage Bot Lifecycle', readOnlyHint: false, destructiveHint: true },
    description:
      'Manage bot lifecycle: start, stop, archive, restore, or change trading pairs (DCA only). Each action has specific requirements.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'archive', 'restore', 'changePairs'],
          description: 'Action to perform on the bot',
        },
        ...botIdRequired,
        botType: {
          type: 'string',
          enum: ['dca', 'combo', 'grid'],
          description: 'Bot type',
        },
        ...paperContextParam,
        closeType: {
          type: 'string',
          enum: ['cancel', 'closeByLimit', 'closeByMarket', 'leave'],
          description:
            'Close type for stop action (dca/combo). "closeByMarket" closes all positions, "leave" pauses the bot.',
        },
        closeGridType: {
          type: 'string',
          enum: ['cancel', 'closeByMarket', 'closeByLimit'],
          description: 'Close type for stop action (grid only)',
        },
        cancelPartiallyFilled: {
          type: 'boolean',
          description:
            'Whether to cancel partially filled orders when stopping (optional)',
        },
        pair: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Full replacement set of trading pairs for changePairs action (DCA, multi-pair bots only). ' +
            'Underscore format, e.g. ["BTC_USDT","ETH_USDT"]. Replaces all existing pairs. ' +
            'Single-coin bots reject pair changes.',
        },
      },
      required: ['action', 'botId', 'botType'],
    },
  },

  // ─── Deals ───────────────────────────────────────────────────────────────

  {
    name: 'list_deals',
    annotations: { title: 'List Deals', readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    description:
      'List deals by type (DCA, Combo, or Terminal). Supports field selection presets. Supports filtering by status and botId.',
    inputSchema: {
      type: 'object',
      properties: {
        dealType: {
          type: 'string',
          enum: ['dca', 'combo', 'terminal'],
          description: 'Deal type',
        },
        ...fieldsParam,
        ...pageParam,
        ...dealStatusParam,
        ...paperContextParam,
        botId: {
          type: 'string',
          description: 'Filter by bot ID (optional)',
        },
      },
      required: ['dealType'],
    },
    outputSchema: envelopeOutput(
      arrayData('Matching deal records; fields present depend on the `fields` preset.'),
      'Gainium API envelope with the list of deals in `data`.',
    ),
  },

  {
    name: 'get_deal',
    annotations: { title: 'Get Deal', readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    description:
      'Get a single deal by its MongoDB ObjectId. Supports the same field selection presets as list_deals.',
    inputSchema: {
      type: 'object',
      properties: {
        dealType: {
          type: 'string',
          enum: ['dca', 'combo', 'terminal'],
          description: 'Deal type',
        },
        ...dealIdRequired,
        ...fieldsParam,
        ...paperContextParam,
      },
      required: ['dealType', 'dealId'],
    },
    outputSchema: envelopeOutput(
      objectData('The deal record; fields present depend on the `fields` preset.'),
      'Gainium API envelope with the deal in `data`.',
    ),
  },

  {
    name: 'create_deal',
    annotations: { title: 'Create Deal', readOnlyHint: false, destructiveHint: true },
    description:
      'Create a new deal. For dca/combo: starts a deal from an existing bot. For terminal: creates a standalone terminal deal.',
    inputSchema: {
      type: 'object',
      properties: {
        dealType: {
          type: 'string',
          enum: ['dca', 'combo', 'terminal'],
          description: 'Deal type',
        },
        ...paperContextParam,
        botId: {
          type: 'string',
          description: 'Bot ID (required for dca/combo)',
        },
        symbol: {
          type: 'string',
          description: 'Optional symbol override (dca/combo)',
        },
        exchangeUUID: {
          type: 'string',
          description: 'Exchange UUID (required for terminal)',
        },
        terminalDealType: {
          type: 'string',
          description: 'Terminal deal type (required for terminal)',
        },
        pair: {
          type: 'string',
          description: 'Trading pair for terminal (optional)',
        },
        strategy: {
          type: 'string',
          enum: ['LONG', 'SHORT'],
          description: 'Trading strategy for terminal',
        },
        baseOrderSize: {
          type: 'string',
          description: 'Base order size for terminal',
        },
        orderSize: {
          type: 'string',
          description: 'Order size for terminal',
        },
        tpPerc: {
          type: 'string',
          description: 'Take profit percentage for terminal',
        },
        slPerc: {
          type: 'string',
          description: 'Stop loss percentage for terminal',
        },
        settings: {
          type: 'object',
          description:
            'Transparent passthrough for any additional terminal deal settings. Merged flat into request body.',
        },
      },
      required: ['dealType'],
    },
  },

  {
    name: 'update_deal',
    annotations: { title: 'Update Deal', readOnlyHint: false, destructiveHint: true },
    description:
      'Update an existing deal. Pass only the fields you want to change. Settings object must be non-empty.',
    inputSchema: {
      type: 'object',
      properties: {
        dealType: {
          type: 'string',
          enum: ['dca', 'combo', 'terminal'],
          description: 'Deal type',
        },
        ...dealIdRequired,
        ...paperContextParam,
        settings: {
          type: 'object',
          minProperties: 1,
          description:
            'Settings object with fields to update. Only include changed fields.',
        },
      },
      required: ['dealType', 'dealId', 'settings'],
    },
  },

  {
    name: 'manage_deal',
    annotations: { title: 'Manage Deal', readOnlyHint: false, destructiveHint: true },
    description:
      'Manage deal operations: close a deal, add funds, or reduce funds. Each action has specific requirements.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['close', 'addFunds', 'reduceFunds'],
          description: 'Action to perform on the deal',
        },
        ...dealIdRequired,
        dealType: {
          type: 'string',
          enum: ['dca', 'combo', 'terminal'],
          description: 'Deal type',
        },
        ...paperContextParam,
        closeType: {
          type: 'string',
          enum: ['cancel', 'closeByLimit', 'closeByMarket', 'leave'],
          description: 'Close type for close action',
        },
        botId: {
          type: 'string',
          description:
            'Bot ID for addFunds/reduceFunds (alternative to dealId for dca/combo)',
        },
        qty: {
          type: 'string',
          description:
            'Amount to add/reduce. With type="fixed" it is an amount in the chosen asset denomination; with type="perc" it is a percentage of the position.',
        },
        type: {
          type: 'string',
          enum: ['fixed', 'perc'],
          description: 'Type: fixed amount or percentage',
        },
        asset: {
          type: 'string',
          enum: ['base', 'quote'],
          description:
            'Denomination for a fixed add/reduce — "quote" (e.g. USDT) or "base" (the coin). Required when type="fixed"; this is NOT a ticker symbol. Ignored when type="perc".',
        },
        symbol: {
          type: 'string',
          description: 'Symbol override (optional)',
        },
      },
      required: ['action', 'dealId', 'dealType'],
    },
  },

  // ─── Backtest ────────────────────────────────────────────────────────────

  {
    name: 'run_backtest',
    annotations: { title: 'Run Backtest', readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    description:
      'Run a backtest operation: validate, estimate cost, request async, or request with sync response. Pass a backtest payload with exchange, exchangeUUID, and bot settings.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['validate', 'estimate', 'request', 'requestSync'],
          description:
            'Backtest mode. validate: confirm payload. estimate: check credit cost. request: async backtest. requestSync: wait for result.',
        },
        botType: {
          type: 'string',
          enum: ['dca', 'combo', 'grid'],
          description: 'Bot type for the backtest',
        },
        ...backtestPayloadParam,
        ...paperContextParam,
        fields: {
          type: 'string',
          description: 'Field selection for requestSync mode (optional)',
        },
      },
      required: ['mode', 'botType', 'payload'],
    },
  },

  {
    name: 'backtest_info',
    annotations: { title: 'Backtest Info', readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    description:
      'Get backtest information: list requests, fetch a specific request, get operation schema, or build a payload template.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['requests', 'request', 'schema', 'template'],
          description:
            'Information target. requests: list all. request: fetch one. schema: operation schema. template: payload template.',
        },
        botType: {
          type: 'string',
          enum: ['dca', 'combo', 'grid'],
          description: 'Bot type',
        },
        ...fieldsParam,
        ...pageParam,
        id: {
          type: 'string',
          description: 'Request ID (required for target="request")',
        },
        exchange: {
          type: 'string',
          description:
            'Exchange code for template (optional, default: binance)',
        },
      },
      required: ['target', 'botType'],
    },
    outputSchema: genericObjectOutput(
      'For target="requests"/"request": the Gainium API envelope ({status, reason, data, meta?}) with existing backtest request records. For target="schema"/"template": a locally generated guidance object describing the backtest payload shape and operations.',
    ),
  },

  // ─── Discovery ───────────────────────────────────────────────────────────

  {
    name: 'discover',
    annotations: { title: 'Discover Resources', readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    description:
      'Discover bots, bot details, bot sections, indicators, or supported exchanges. Use this to learn available fields, defaults, and strategies.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: [
            'bots',
            'bot',
            'botSections',
            'indicators',
            'indicator',
            'supportedExchanges',
          ],
          description:
            'Discovery target. bots: list all. bot: details for one. botSections: list sections. indicators: list all. indicator: details for one. supportedExchanges: list all.',
        },
        botType: {
          type: 'string',
          enum: ['dca', 'combo', 'grid'],
          description: 'Bot type (required for bot/botSections)',
        },
        section: {
          type: 'string',
          description: 'Section name for bot discovery (optional)',
        },
        type: {
          type: 'string',
          description: 'Indicator type (required for target="indicator")',
        },
        action: {
          type: 'string',
          description:
            'Action filter for indicators (optional: "add", "close", "update")',
        },
        exchange: {
          type: 'string',
          description: 'Exchange code for indicators (optional)',
        },
      },
      required: ['target'],
    },
    outputSchema: envelopeOutput(
      anyData('Discovery metadata for the requested target: bot schemas, bot sections, indicator schemas (object), or lists of bots/indicators/exchanges (array).'),
      'Gainium API envelope with discovery metadata in `data`.',
    ),
  },

  // ─── Account & Settings ──────────────────────────────────────────────────

  {
    name: 'get_account',
    annotations: { title: 'Get Account', readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    description:
      'Get account information: balances, connected exchanges, global variables, or supported exchanges.',
    inputSchema: {
      type: 'object',
      properties: {
        info: {
          type: 'string',
          enum: [
            'balances',
            'exchanges',
            'globalVariables',
            'supportedExchanges',
          ],
          description:
            'Information type. balances: account balances. exchanges: connected exchanges. globalVariables: user variables. supportedExchanges: API supports.',
        },
        ...fieldsParam,
        ...pageParam,
        ...paperContextParam,
        exchangeId: {
          type: 'string',
          description: 'Filter by exchange ID (balances only)',
        },
        asset: {
          type: 'string',
          description: 'Filter by single asset (balances only)',
        },
        assets: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Filter by multiple assets (balances only). Use asset OR assets, not both.',
        },
      },
      required: ['info'],
    },
    outputSchema: envelopeOutput(
      anyData('Account information for the requested type: balances, connected exchanges, global variables, or supported exchanges (array or object depending on `info`).'),
      'Gainium API envelope with account information in `data`.',
    ),
  },

  {
    name: 'manage_global_variable',
    annotations: { title: 'Manage Global Variable', readOnlyHint: false, destructiveHint: true },
    description:
      'Create, update, or delete a global variable. Variables are user-defined constants accessible in strategies.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'delete'],
          description: 'Action to perform',
        },
        id: {
          type: 'string',
          description: 'Variable ID (required for update/delete)',
        },
        name: {
          type: 'string',
          description:
            'Variable name (required for create, optional for update)',
        },
        type: {
          type: 'string',
          enum: ['text', 'int', 'float'],
          description:
            'Variable type (required for create, optional for update)',
        },
        value: {
          type: 'string',
          description:
            'Variable value (required for create, optional for update)',
        },
      },
      required: ['action'],
    },
  },

  // ─── General ─────────────────────────────────────────────────────────────

  {
    name: 'get_screener',
    annotations: { title: 'Get Screener', readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    description:
      'Get cryptocurrency screener results. Filter by market cap, volume, and sort by various metrics.',
    inputSchema: {
      type: 'object',
      properties: {
        ...fieldsParam,
        ...pageParam,
        category: {
          type: 'string',
          description: 'Filter by category (optional)',
        },
        minMarketCap: {
          type: 'number',
          description: 'Minimum market cap (optional)',
        },
        maxMarketCap: {
          type: 'number',
          description: 'Maximum market cap (optional)',
        },
        minVolume: {
          type: 'number',
          description: 'Minimum volume (optional)',
        },
        sort: {
          type: 'string',
          description:
            'Sort field (applied client-side; the API does not sort). One of: ' +
            '"volatility" (largest absolute 24h % change), "priceChange"/"change", ' +
            '"volume"/"totalVolume", "marketCap", "price". Use "volatility" to find the most volatile pairs.',
        },
        order: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Sort order (optional, default desc when sorting)',
        },
        maxPages: {
          type: 'number',
          description:
            'When sorting, how many pages (10 coins each, ≤30, default 10) to fetch and rank across. ' +
            'Higher = wider pool for "most volatile" but more requests.',
        },
      },
    },
    outputSchema: envelopeOutput(
      arrayData('Screener rows (coins) with market data. When `sort` is used, ranked client-side and `meta` records the sort details.'),
      'Gainium API envelope with screener rows in `data`.',
    ),
  },

  {
    name: 'list_presets',
    annotations: { title: 'List Curated Presets', readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    description:
      'List curated bot-strategy presets, ranked by backtested performance. Each coin returns tiers ' +
      '(short/mid/long) × strategy (long/short) with ROI, drawdown, and the full strategy settings ' +
      'for review and comparison.',
    inputSchema: {
      type: 'object',
      properties: {
        botType: {
          type: 'string',
          enum: ['dca', 'combo', 'grid'],
          description: 'Bot type to list presets for',
        },
        coin: {
          type: 'string',
          description:
            'Filter to a single base asset, e.g. "BTC" (skips the closed-deals floor)',
        },
        exchange: {
          type: 'string',
          description: 'Canonical exchange, e.g. "binance" (use with coin)',
        },
        strategy: {
          type: 'string',
          enum: ['long', 'short'],
          description: 'Filter by direction (optional)',
        },
        limit: {
          type: 'number',
          description: 'Max coins to return (default 10, max 50)',
        },
        summary: {
          type: 'boolean',
          description:
            'Omit the per-tier settings blob for a lightweight ranked list (default false)',
        },
        includeNoDeals: {
          type: 'boolean',
          description:
            'Include coins with fewer than the minimum closed deals (default false)',
        },
      },
      required: ['botType'],
    },
    outputSchema: envelopeOutput(
      arrayData('Curated preset rows (one per coin), each with tiers × strategy, ROI, drawdown, and (unless summary) the full settings blob.'),
      'Gainium API envelope with curated presets in `data`.',
    ),
  },

  {
    name: 'apply_preset',
    annotations: {
      title: 'Apply Curated Preset',
      readOnlyHint: false,
      destructiveHint: true,
    },
    description:
      'Create a bot from a curated preset in one call: fetches the preset for the given coin/exchange/tier/strategy, ' +
      'then creates a bot from its settings. Override pair, name, or sizing as needed.',
    inputSchema: {
      type: 'object',
      properties: {
        botType: {
          type: 'string',
          enum: ['dca', 'combo', 'grid'],
          description: 'Bot type',
        },
        coin: { type: 'string', description: 'Base asset, e.g. "BTC"' },
        exchange: {
          type: 'string',
          description: 'Preset exchange, e.g. "binance"',
        },
        tier: {
          type: 'string',
          enum: ['short', 'mid', 'long'],
          description: 'Risk tier: short (tight), mid (balanced), long (wide)',
        },
        strategy: {
          type: 'string',
          enum: ['long', 'short'],
          description: 'Direction (default "long")',
        },
        exchangeUUID: {
          type: 'string',
          description:
            'UUID of YOUR connected exchange to create the bot on (from get_account info:"exchanges")',
        },
        ...paperContextParam,
        pair: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Override the preset pair(s), underscore format e.g. ["BTC_USDT"] (optional)',
        },
        name: {
          type: 'string',
          description: 'Override the bot name (optional)',
        },
      },
      required: ['botType', 'coin', 'exchange', 'tier', 'exchangeUUID'],
    },
  },
]

// Read-only mode (GAINIUM_READONLY=true): expose and allow ONLY tools annotated
// readOnlyHint:true. Used for the directory-listed connector, which must not
// execute financial transactions (Anthropic Software Directory Policy §4A). The
// full read+write server is unaffected when the flag is off.
export const READONLY_MODE = process.env.GAINIUM_READONLY === 'true'
export const exposedTools: Tool[] = READONLY_MODE
  ? tools.filter((t) => t.annotations?.readOnlyHint === true)
  : tools
const READONLY_TOOL_NAMES = new Set(exposedTools.map((t) => t.name))

// Tools that declare an outputSchema. For these we also emit `structuredContent`
// (the parsed JSON) alongside the text block, so clients that validate against
// the schema get a conforming structured payload.
const OUTPUT_SCHEMA_TOOL_NAMES = new Set(
  tools.filter((t) => t.outputSchema).map((t) => t.name),
)

// ── Tool Handler ────────────────────────────────────────────────────────────

async function handleToolCall(
  name: string,
  args: Record<string, any>,
  client: GainiumClient,
): Promise<string> {
  Object.defineProperty(args, '__toolName', {
    value: name,
    enumerable: false,
    configurable: true,
  })
  if (READONLY_MODE && !READONLY_TOOL_NAMES.has(name)) {
    throw new Error(
      `Tool "${name}" is not available on this read-only Gainium connector. ` +
        'This connection exposes read-only tools only.',
    )
  }
  enforceGuards(args)
  validateToolArgs(name, args)

  switch (name) {
    // ── list_bots ────────────────────────────────────────────────────────

    case 'list_bots': {
      const botType = args.botType
      const res = await client.request('GET', `/api/v2/bots/${botType}`, {
        query: {
          fields: args.fields,
          page: args.page,
          status: args.status,
          botId: args.botId,
        },
        headers: paperHeader(args),
      })
      return JSON.stringify(res, null, 2)
    }

    // ── get_bot ──────────────────────────────────────────────────────────

    case 'get_bot': {
      const botType = args.botType
      const res = await client.request(
        'GET',
        `/api/v2/bots/${botType}/details`,
        {
          query: { botId: args.botId, fields: args.fields },
          headers: paperHeader(args),
        },
      )
      return JSON.stringify(res, null, 2)
    }

    // ── create_bot ───────────────────────────────────────────────────────

    case 'create_bot': {
      const botType = args.botType
      const { settings = {}, paperContext, ...topLevel } = args
      const body = { ...settings, ...topLevel }
      delete body.settings
      delete body.paperContext
      delete body.botType
      // Grid API expects pair as a single string, not an array
      if (botType === 'grid' && Array.isArray(body.pair)) {
        body.pair = body.pair[0]
      }
      const res = await client.request('POST', `/api/v2/bots/${botType}`, {
        body,
        headers: paperHeader(args),
      })
      return JSON.stringify(res, null, 2)
    }

    // ── update_bot ───────────────────────────────────────────────────────

    case 'update_bot': {
      const botType = args.botType
      const defaults = applySettingsSafeDefaults(args.settings, 'bot')
      const res = await client.request(
        'PUT',
        `/api/v2/bots/${botType}/${args.botId}`,
        {
          body: args.settings,
          headers: paperHeader(args),
        },
      )
      const mismatches = await verifySettingsApplied(
        client,
        'bot',
        botType,
        args.botId,
        args.settings,
        args,
      )
      return JSON.stringify(
        decorateWriteResult(res, defaults, mismatches),
        null,
        2,
      )
    }

    // ── clone_bot ────────────────────────────────────────────────────────

    case 'clone_bot': {
      const botType = args.botType
      const res = await client.request(
        'POST',
        `/api/v2/bots/${botType}/${args.botId}/clone`,
        {
          body: args.overrides || {},
          headers: paperHeader(args),
        },
      )
      return JSON.stringify(res, null, 2)
    }

    // ── manage_bot ───────────────────────────────────────────────────────

    case 'manage_bot': {
      const action = args.action
      const botType = args.botType
      const botId = args.botId

      if (action === 'start') {
        const res = await client.request(
          'POST',
          `/api/v2/bots/${botType}/${botId}/start`,
          {
            headers: paperHeader(args),
          },
        )
        return JSON.stringify(res, null, 2)
      }

      if (action === 'stop') {
        const res = await client.request(
          'POST',
          `/api/v2/bots/${botType}/${botId}/stop`,
          {
            query: {
              closeType: args.closeType,
              closeGridType: args.closeGridType,
              cancelPartiallyFilled:
                args.cancelPartiallyFilled !== undefined
                  ? String(args.cancelPartiallyFilled)
                  : undefined,
            },
            headers: paperHeader(args),
          },
        )
        return JSON.stringify(res, null, 2)
      }

      if (action === 'archive') {
        const res = await client.request(
          'DELETE',
          `/api/v2/bots/${botType}/${botId}`,
          {
            headers: paperHeader(args),
          },
        )
        return JSON.stringify(res, null, 2)
      }

      if (action === 'restore') {
        const res = await client.request(
          'POST',
          `/api/v2/bots/${botType}/${botId}/restore`,
          {
            headers: paperHeader(args),
          },
        )
        return JSON.stringify(res, null, 2)
      }

      if (action === 'changePairs') {
        const res = await client.request(
          'PUT',
          `/api/v2/bots/dca/${botId}/pairs`,
          {
            // API field is `pairsToSet` (replaces the full pair set), NOT `pair`.
            // Pairs use underscore format, e.g. ["BTC_USDT","ETH_USDT"].
            // Only multi-pair bots (useMulti: true) accept pair changes.
            body: { pairsToSet: args.pair },
            headers: paperHeader(args),
          },
        )
        return JSON.stringify(res, null, 2)
      }

      throw new Error(`Unknown manage_bot action: ${action}`)
    }

    // ── list_deals ───────────────────────────────────────────────────────

    case 'list_deals': {
      const dealType = args.dealType
      const res = await client.request('GET', `/api/v2/deals/${dealType}`, {
        query: {
          fields: args.fields,
          page: args.page,
          status: args.status,
          botId: args.botId,
        },
        headers: paperHeader(args),
      })
      return JSON.stringify(res, null, 2)
    }

    // ── get_deal ─────────────────────────────────────────────────────────

    case 'get_deal': {
      const dealType = args.dealType
      const res = await client.request(
        'GET',
        `/api/v2/deals/${dealType}/details`,
        {
          query: { dealId: args.dealId, fields: args.fields },
          headers: paperHeader(args),
        },
      )
      return JSON.stringify(res, null, 2)
    }

    // ── create_deal ──────────────────────────────────────────────────────

    case 'create_deal': {
      const dealType = args.dealType

      if (dealType === 'terminal') {
        const { settings = {}, paperContext, ...topLevel } = args
        const body = { ...settings, ...topLevel }
        delete body.settings
        delete body.paperContext
        delete body.dealType
        const res = await client.request('POST', '/api/v2/deals/terminal', {
          body,
          headers: paperHeader(args),
        })
        return JSON.stringify(res, null, 2)
      }

      // dca/combo
      const query: Record<string, any> = {}
      if (args.symbol) query.symbol = args.symbol
      const res = await client.request(
        'POST',
        `/api/v2/deals/${dealType}/${args.botId}/start`,
        {
          query,
          headers: paperHeader(args),
        },
      )
      return JSON.stringify(res, null, 2)
    }

    // ── update_deal ──────────────────────────────────────────────────────

    case 'update_deal': {
      const dealType = args.dealType
      const defaults = applySettingsSafeDefaults(args.settings, 'deal')
      const res = await client.request(
        'PUT',
        `/api/v2/deals/${dealType}/${args.dealId}`,
        {
          body: args.settings,
          headers: paperHeader(args),
        },
      )
      const mismatches = await verifySettingsApplied(
        client,
        'deal',
        dealType,
        args.dealId,
        args.settings,
        args,
      )
      return JSON.stringify(
        decorateWriteResult(res, defaults, mismatches),
        null,
        2,
      )
    }

    // ── manage_deal ──────────────────────────────────────────────────────

    case 'manage_deal': {
      const action = args.action
      const dealType = args.dealType
      const dealId = args.dealId

      if (action === 'close') {
        const res = await client.request(
          'DELETE',
          `/api/v2/deals/${dealType}/${dealId}`,
          {
            query: { type: args.closeType },
            headers: paperHeader(args),
          },
        )
        return JSON.stringify(res, null, 2)
      }

      if (action === 'addFunds' || action === 'reduceFunds') {
        const body: Record<string, any> = {
          qty: args.qty,
        }
        if (args.type) body.type = args.type
        if (args.asset) body.asset = args.asset
        if (args.symbol) body.symbol = args.symbol

        // Terminal deals have different endpoint
        if (dealType === 'terminal') {
          const endpoint = action === 'addFunds' ? 'add-funds' : 'reduce-funds'
          const res = await client.request(
            'POST',
            `/api/v2/deals/terminal/${dealId}/${endpoint}`,
            { body },
          )
          return JSON.stringify(res, null, 2)
        }

        // DCA/Combo deals
        const endpoint = action === 'addFunds' ? 'add-funds' : 'reduce-funds'
        const res = await client.request(
          'POST',
          `/api/v2/deals/dca/${endpoint}`,
          {
            query: {
              dealId: args.dealId,
              botId: args.botId,
            },
            body,
            headers: paperHeader(args),
          },
        )
        return JSON.stringify(res, null, 2)
      }

      throw new Error(`Unknown manage_deal action: ${action}`)
    }

    // ── run_backtest ─────────────────────────────────────────────────────

    case 'run_backtest': {
      const mode = args.mode
      const botType = args.botType

      if (mode === 'validate') {
        const res = await client.request(
          'POST',
          `/api/v2/backtest/${botType}/validate`,
          {
            body: { payload: args.payload },
            headers: paperHeader(args),
          },
        )
        return JSON.stringify(res, null, 2)
      }

      if (mode === 'estimate') {
        const res = await client.request(
          'POST',
          `/api/v2/backtest/${botType}/estimate-cost`,
          {
            body: { payload: args.payload },
            headers: paperHeader(args),
          },
        )
        return JSON.stringify(res, null, 2)
      }

      if (mode === 'request') {
        const res = await client.request(
          'POST',
          `/api/v2/backtest/${botType}/request`,
          {
            body: { payload: args.payload },
            headers: paperHeader(args),
          },
        )
        return JSON.stringify(res, null, 2)
      }

      if (mode === 'requestSync') {
        const res = await client.request(
          'POST',
          `/api/v2/backtest/${botType}/request/sync`,
          {
            query: { fields: args.fields },
            body: { payload: args.payload },
            headers: paperHeader(args),
          },
        )
        return JSON.stringify(res, null, 2)
      }

      throw new Error(`Unknown run_backtest mode: ${mode}`)
    }

    // ── backtest_info ────────────────────────────────────────────────────

    case 'backtest_info': {
      const target = args.target
      const botType = args.botType

      if (target === 'requests') {
        const res = await client.request(
          'GET',
          `/api/v2/backtest/${botType}/requests`,
          {
            query: {
              fields: args.fields,
              page: args.page,
            },
            headers: paperHeader(args),
          },
        )
        return JSON.stringify(res, null, 2)
      }

      if (target === 'request') {
        const res = await client.request(
          'GET',
          `/api/v2/backtest/${botType}/requests/${args.id}`,
          {
            query: { fields: args.fields },
          },
        )
        return JSON.stringify(res, null, 2)
      }

      if (target === 'schema') {
        const schema = {
          botType,
          outerShape: {
            botType: `"${botType}"`,
            paperContext: 'boolean (optional, default false)',
            payload: {
              data: {
                exchange: 'string — exchange code, e.g. "binance", "okxLinear"',
                exchangeUUID:
                  'string — UUID from get_account(info: "exchanges")',
                settings: `<inner ${botType} settings object — use discover(target: "bot", botType: "${botType}") to learn fields>`,
                from: 'number (optional) — range start as Unix ms timestamp',
                to: 'number (optional) — range end as Unix ms timestamp',
                interval:
                  'string (optional) — candle interval: "1m"|"5m"|"15m"|"1h"|"4h"|"1d"',
              },
            },
          },
          operations: [
            {
              name: 'validate',
              method: 'POST',
              path: `/api/v2/backtest/${botType}/validate`,
              credits: false,
              note: 'Validates and returns normalized settings. from/to/interval optional.',
            },
            {
              name: 'estimate-cost',
              method: 'POST',
              path: `/api/v2/backtest/${botType}/estimate-cost`,
              credits: false,
              note: 'Returns estimated credit cost before committing.',
            },
            {
              name: 'request',
              method: 'POST',
              path: `/api/v2/backtest/${botType}/request`,
              credits: true,
              note: 'Submits async backtest. Returns requestId.',
            },
            {
              name: 'request/sync',
              method: 'POST',
              path: `/api/v2/backtest/${botType}/request/sync`,
              credits: true,
              note: 'Submits and waits for result. Returns full result or requestId if timed out.',
            },
          ],
          recommendedFlow:
            'get_account(info: "exchanges") -> discover(target: "bot") -> build_backtest_payload_template -> run_backtest(mode: "validate") -> run_backtest(mode: "estimate") -> run_backtest(mode: "requestSync")',
        }
        return JSON.stringify(schema, null, 2)
      }

      if (target === 'template') {
        const exchange: string = isNonEmptyString(args.exchange)
          ? args.exchange
          : 'binance'
        const baseSettings: Record<string, any> = {
          name: `My ${botType.toUpperCase()} backtest`,
          pair: ['BTC_USDT'],
          strategy: 'LONG',
          startCondition: 'ASAP',
          useTp: true,
          tpPerc: '2',
        }
        if (botType === 'dca') {
          Object.assign(baseSettings, {
            baseOrderSize: '100',
            orderSize: '100',
            orderSizeType: 'quote',
            useDca: true,
            ordersCount: 5,
            step: '1.5',
          })
        } else if (botType === 'combo') {
          Object.assign(baseSettings, {
            baseOrderSize: '100',
            orderSize: '100',
            gridLevel: '5',
            step: '1.5',
          })
        } else if (botType === 'grid') {
          Object.assign(baseSettings, {
            topPrice: 50000,
            lowPrice: 40000,
            budget: 1000,
            levels: 10,
            gridType: 'arithmetic',
          })
        }
        const template = {
          botType,
          paperContext: false,
          payload: {
            data: {
              exchange,
              exchangeUUID:
                '<replace: use get_account(info: "exchanges") to find your UUID>',
              from: 1704067200000,
              to: 1735689600000,
              interval: '1h',
              settings: baseSettings,
            },
          },
          _instructions: [
            'Replace exchangeUUID using get_account(info: "exchanges")',
            'Adjust settings fields using discover(target: "bot", botType) for available options',
            'Pass this object to run_backtest(mode: "validate") before estimating cost',
          ],
        }
        return JSON.stringify(template, null, 2)
      }

      throw new Error(`Unknown backtest_info target: ${target}`)
    }

    // ── discover ─────────────────────────────────────────────────────────

    case 'discover': {
      const target = args.target

      if (target === 'bots') {
        const res = await client.request('GET', '/api/v2/discovery/bots')
        return JSON.stringify(res, null, 2)
      }

      if (target === 'bot') {
        const res = await client.request(
          'GET',
          `/api/v2/discovery/bots/${args.botType}`,
          {
            query: { section: args.section },
          },
        )
        return JSON.stringify(res, null, 2)
      }

      if (target === 'botSections') {
        const res = await client.request(
          'GET',
          `/api/v2/discovery/bots/${args.botType}/sections`,
        )
        return JSON.stringify(res, null, 2)
      }

      if (target === 'indicators') {
        const res = await client.request(
          'GET',
          '/api/v2/discovery/indicators',
          {
            query: {
              action: args.action,
              exchange: args.exchange,
            },
          },
        )
        return JSON.stringify(res, null, 2)
      }

      if (target === 'indicator') {
        const res = await client.request(
          'GET',
          `/api/v2/discovery/indicators/${encodeURIComponent(args.type)}`,
          {
            query: { exchange: args.exchange },
          },
        )
        return JSON.stringify(res, null, 2)
      }

      if (target === 'supportedExchanges') {
        const res = await client.request('GET', '/api/v2/exchanges')
        return JSON.stringify(res, null, 2)
      }

      throw new Error(`Unknown discover target: ${target}`)
    }

    // ── get_account ──────────────────────────────────────────────────────

    case 'get_account': {
      const info = args.info

      if (info === 'balances') {
        const res = await client.request('GET', '/api/v2/user/balances', {
          query: {
            fields: args.fields,
            exchangeId: args.exchangeId,
            asset: args.asset,
            assets: args.assets,
          },
          headers: paperHeader(args),
        })
        return JSON.stringify(res, null, 2)
      }

      if (info === 'exchanges') {
        const res = await client.request('GET', '/api/v2/user/exchanges', {
          headers: paperHeader(args),
        })
        return JSON.stringify(res, null, 2)
      }

      if (info === 'globalVariables') {
        const res = await client.request('GET', '/api/v2/user/global-vars', {
          query: { page: args.page },
        })
        return JSON.stringify(res, null, 2)
      }

      if (info === 'supportedExchanges') {
        const res = await client.request('GET', '/api/v2/exchanges')
        return JSON.stringify(res, null, 2)
      }

      throw new Error(`Unknown get_account info: ${info}`)
    }

    // ── manage_global_variable ───────────────────────────────────────────

    case 'manage_global_variable': {
      const action = args.action

      if (action === 'create') {
        const res = await client.request('POST', '/api/v2/user/global-vars', {
          body: { name: args.name, type: args.type, value: args.value },
        })
        return JSON.stringify(res, null, 2)
      }

      if (action === 'update') {
        const body: Record<string, any> = {}
        if (args.name !== undefined) body.name = args.name
        if (args.type !== undefined) body.type = args.type
        if (args.value !== undefined) body.value = args.value
        const res = await client.request(
          'PUT',
          `/api/v2/user/global-vars/${args.id}`,
          { body },
        )
        return JSON.stringify(res, null, 2)
      }

      if (action === 'delete') {
        const res = await client.request(
          'DELETE',
          `/api/v2/user/global-vars/${args.id}`,
        )
        return JSON.stringify(res, null, 2)
      }

      throw new Error(`Unknown manage_global_variable action: ${action}`)
    }

    // ── get_screener ─────────────────────────────────────────────────────

    case 'get_screener': {
      const baseQuery = {
        category: args.category,
        minMarketCap: args.minMarketCap,
        maxMarketCap: args.maxMarketCap,
        minVolume: args.minVolume,
      }

      // The screener API ignores sort/order server-side (every sort returns the same
      // order). When a sort is requested we fetch a bounded number of pages and sort
      // client-side. Without a sort, pass through with normal pagination.
      if (!isNonEmptyString(args.sort)) {
        const res = await client.request('GET', '/api/v2/screener', {
          query: { ...baseQuery, fields: args.fields, page: args.page },
        })
        return JSON.stringify(res, null, 2)
      }

      const SORT_KEYS = SCREENER_SORT_KEYS
      const keyFn = SORT_KEYS[String(args.sort).toLowerCase()]
      if (!keyFn) {
        throw new Error(
          `Unsupported sort "${args.sort}". Supported: ${Object.keys(SORT_KEYS).join(', ')}. ` +
            '"volatility" = largest absolute 24h price change.',
        )
      }
      const order = args.order === 'asc' ? 'asc' : 'desc'
      const maxPages = Math.min(Math.max(Number(args.maxPages) || 10, 1), 30)

      // Fetch pages in parallel. Use the API default field set (not args.fields) so the
      // sort keys (priceChangePercentage24h, totalVolume, marketCap) are always present.
      const pages = await Promise.all(
        Array.from({ length: maxPages }, (_, i) =>
          client
            .request('GET', '/api/v2/screener', {
              query: { ...baseQuery, page: i + 1 },
            })
            .then((r: any) => (Array.isArray(r?.data) ? r.data : []))
            .catch(() => []),
        ),
      )
      const all = pages.flat()
      all.sort((a, b) =>
        order === 'asc' ? keyFn(a) - keyFn(b) : keyFn(b) - keyFn(a),
      )

      const perPage = 10
      const page = Math.max(Number(args.page) || 1, 1)
      const start = (page - 1) * perPage
      const out = {
        status: 'OK',
        reason: null,
        data: all.slice(start, start + perPage),
        meta: {
          sortedBy: args.sort,
          order,
          clientSideSort: true,
          pagesFetched: maxPages,
          totalSorted: all.length,
          page,
          note: `Sorted client-side across ${all.length} coins from the first ${maxPages} page(s); the screener API does not sort server-side. Raise maxPages (≤30) to widen the pool.`,
        },
      }
      return JSON.stringify(out, null, 2)
    }

    // ── list_presets ─────────────────────────────────────────────────────
    case 'list_presets': {
      const res = await client.request('GET', '/api/curated-presets', {
        query: {
          botType: args.botType,
          coin: args.coin,
          exchange: args.exchange,
          strategy: args.strategy,
          limit: args.limit,
          summary: args.summary ? '1' : undefined,
          includeNoDeals: args.includeNoDeals ? '1' : undefined,
        },
      })
      return JSON.stringify(res, null, 2)
    }

    // ── apply_preset ─────────────────────────────────────────────────────
    case 'apply_preset': {
      const botType = args.botType
      const strategy = isNonEmptyString(args.strategy) ? args.strategy : 'long'
      // Fetch the full preset (settings blob included when summary is omitted).
      const presetRes: any = await client.request('GET', '/api/curated-presets', {
        query: {
          botType,
          coin: args.coin,
          exchange: args.exchange,
        },
      })
      const coinRow = Array.isArray(presetRes?.data) ? presetRes.data[0] : null
      if (!coinRow) {
        throw new Error(
          `No preset found for ${args.coin} on ${args.exchange} (botType ${botType}).`,
        )
      }
      const match = (coinRow.tiers || []).find(
        (t: any) => t.tier === args.tier && t.strategy === strategy,
      )
      if (!match || !match.settings) {
        const available = (coinRow.tiers || [])
          .map((t: any) => `${t.tier}/${t.strategy}`)
          .join(', ')
        throw new Error(
          `No "${args.tier}/${strategy}" tier with settings for ${args.coin}. Available: ${available}`,
        )
      }
      // Build the create-bot body from the preset settings + caller overrides.
      // The preset blob is a stored bot config, so it carries runtime/computed fields
      // that the create endpoint rejects as input — strip them.
      const body: Record<string, any> = { ...match.settings }
      for (const f of PRESET_STRIP_FIELDS) delete body[f]
      body.exchangeUUID = args.exchangeUUID
      // Pair: prefer caller override; else normalise the preset's pair (e.g. "BTCUSDT"
      // or "LAB-USDT") to the underscore input format create_bot expects.
      const presetPair = toUnderscorePair(coinRow.pair, coinRow.coin)
      let pair: any = args.pair !== undefined ? args.pair : presetPair
      if (botType === 'grid') {
        pair = Array.isArray(pair) ? pair[0] : pair
      } else if (typeof pair === 'string') {
        pair = [pair]
      }
      body.pair = pair
      if (isNonEmptyString(args.name)) body.name = args.name
      const res = await client.request('POST', `/api/v2/bots/${botType}`, {
        body,
        headers: paperHeader(args),
      })
      const out =
        res && typeof res === 'object' ? { ...(res as object) } : { data: res }
      ;(out as any)._appliedPreset = {
        coin: coinRow.coin,
        exchange: coinRow.exchange,
        tier: args.tier,
        strategy,
        roi: match.roi,
        maxDrawDownPerc: match.maxDrawDownPerc,
      }
      return JSON.stringify(out, null, 2)
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ── MCP Server Setup ────────────────────────────────────────────────────────

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: exposedTools,
  }))

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    // The workflow guide describes bot-creation/management; omit it on the
    // read-only connector so the surface points to nothing it can't do.
    resources: READONLY_MODE
      ? []
      : [
          {
            uri: WORKFLOW_RESOURCE_URI,
            name: 'Gainium agent workflow',
            description:
              'Canonical layer model, recommended flows, and terminology reference for using the Gainium MCP tools. Read this to understand how discovery, bot creation, and backtest tools relate to each other.',
            mimeType: 'text/plain',
          },
        ],
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri
    if (uri === WORKFLOW_RESOURCE_URI && !READONLY_MODE) {
      return {
        contents: [
          {
            uri: WORKFLOW_RESOURCE_URI,
            mimeType: 'text/plain',
            text: WORKFLOW_RESOURCE_TEXT,
          },
        ],
      }
    }
    throw new Error(`Unknown resource: ${uri}`)
  })

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: toolArgs } = request.params
    try {
      const client = await createGainiumClientFromHeaders(
        extra.requestInfo?.headers,
      )
      const args = isPlainObject(toolArgs) ? { ...toolArgs } : {}
      const result = await handleToolCall(name, args, client)
      const response: {
        content: { type: 'text'; text: string }[]
        structuredContent?: Record<string, unknown>
      } = { content: [{ type: 'text' as const, text: result }] }
      // For tools that declare an outputSchema, also return the parsed object as
      // structuredContent. Read tools always return a JSON object; skip silently
      // if parsing fails or the top level isn't a plain object.
      if (OUTPUT_SCHEMA_TOOL_NAMES.has(name)) {
        try {
          const parsed = JSON.parse(result)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            response.structuredContent = parsed
          }
        } catch {
          // leave as text-only
        }
      }
      return response
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${error?.message ?? String(error)}`,
          },
        ],
        isError: true,
      }
    }
  })

  return server
}

async function startStdioServer(): Promise<void> {
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(
    `[${SERVER_NAME}] Server started over stdio (v${SERVER_VERSION})`,
  )
}

async function startHttpServer(): Promise<void> {
  const streamableSessions = new Map<string, StreamableHTTPServerTransport>()
  const sseSessions = new Map<string, SSEServerTransport>()

  const closeAllSessions = async (): Promise<void> => {
    const openTransports = [
      ...streamableSessions.values(),
      ...sseSessions.values(),
    ]

    await Promise.allSettled(
      openTransports.map((transport) => transport.close()),
    )
    streamableSessions.clear()
    sseSessions.clear()
  }

  const httpServer = createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        writeTextResponse(res, 400, 'Invalid request')
        return
      }

      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

      // OpenAI Apps domain verification. Public (no auth), served at the origin
      // root so OpenAI can confirm we control this hostname. Returns the exact
      // challenge token as plain text.
      if (url.pathname === '/.well-known/openai-apps-challenge') {
        if (req.method !== 'GET') {
          writeMethodNotAllowed(res, ['GET'])
          return
        }
        if (!OPENAI_APPS_CHALLENGE_TOKEN) {
          writeTextResponse(res, 404, 'Not Found')
          return
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.end(OPENAI_APPS_CHALLENGE_TOKEN)
        return
      }

      // OAuth protected-resource metadata (RFC 9728). Served at both the
      // bare path and the path-inserted variant so clients find it either way.
      if (
        OAUTH_ENABLED &&
        (url.pathname === resourceMetadataPath() ||
          url.pathname === '/.well-known/oauth-protected-resource')
      ) {
        if (req.method !== 'GET') {
          writeMethodNotAllowed(res, ['GET'])
          return
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.end(JSON.stringify(resourceMetadataDoc(req)))
        return
      }

      if (url.pathname === MCP_HTTP_PATH) {
        if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
          writeMethodNotAllowed(res, ['GET', 'POST', 'DELETE'])
          return
        }

        // Reject unauthenticated requests with a 401 challenge so the client
        // can discover the authorization server and run the OAuth flow.
        if (!(await ensureAuthorized(req, res))) {
          return
        }

        const sessionId = getHeaderValue(req.headers['mcp-session-id'])
        const parsedBody =
          req.method === 'POST' ? await readJsonBody(req) : undefined

        if (sessionId) {
          const transport = streamableSessions.get(sessionId)
          if (!transport) {
            if (sseSessions.has(sessionId)) {
              writeJsonRpcError(
                res,
                400,
                'Bad Request: Session exists but uses the deprecated SSE transport',
              )
              return
            }

            writeJsonRpcError(res, 404, 'Session not found', -32001)
            return
          }

          await transport.handleRequest(req, res, parsedBody)
          return
        }

        if (req.method !== 'POST' || !isInitializeRequest(parsedBody)) {
          writeJsonRpcError(
            res,
            400,
            'Bad Request: No valid MCP session ID provided',
          )
          return
        }

        let transport: StreamableHTTPServerTransport
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            streamableSessions.set(newSessionId, transport)
          },
        })

        transport.onclose = () => {
          const activeSessionId = transport.sessionId
          if (activeSessionId) {
            streamableSessions.delete(activeSessionId)
          }
        }

        const server = createMcpServer()
        await server.connect(transport)
        await transport.handleRequest(req, res, parsedBody)
        return
      }

      if (url.pathname === MCP_SSE_PATH) {
        if (req.method !== 'GET') {
          writeMethodNotAllowed(res, ['GET'])
          return
        }

        if (!(await ensureAuthorized(req, res))) {
          return
        }

        const transport = new SSEServerTransport(MCP_MESSAGES_PATH, res)
        sseSessions.set(transport.sessionId, transport)
        transport.onclose = () => {
          sseSessions.delete(transport.sessionId)
        }

        const server = createMcpServer()
        await server.connect(transport)
        return
      }

      if (url.pathname === MCP_MESSAGES_PATH) {
        if (req.method !== 'POST') {
          writeMethodNotAllowed(res, ['POST'])
          return
        }

        if (!(await ensureAuthorized(req, res))) {
          return
        }

        const sessionId = url.searchParams.get('sessionId')
        if (!sessionId) {
          writeTextResponse(res, 400, 'Missing sessionId query parameter')
          return
        }

        const transport = sseSessions.get(sessionId)
        if (!transport) {
          if (streamableSessions.has(sessionId)) {
            writeJsonRpcError(
              res,
              400,
              'Bad Request: Session exists but uses Streamable HTTP',
            )
            return
          }

          writeTextResponse(res, 404, 'Session not found')
          return
        }

        await transport.handlePostMessage(req, res)
        return
      }

      writeTextResponse(res, 404, 'Not Found')
    } catch (error: any) {
      console.error(`[${SERVER_NAME}] HTTP transport error:`, error)

      if (!res.headersSent) {
        const message = error?.message || 'Internal server error'
        if (req.url?.startsWith(MCP_HTTP_PATH)) {
          writeJsonRpcError(res, 500, message, -32603)
        } else {
          writeTextResponse(res, 500, message)
        }
      } else if (!res.writableEnded) {
        res.end()
      }
    }
  })

  let isShuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) {
      return
    }
    isShuttingDown = true

    console.error(`[${SERVER_NAME}] Shutting down HTTP server (${signal})`)
    await closeAllSessions()
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
    process.exit(0)
  }

  process.once('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM')
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      httpServer.off('error', onError)
      resolve()
    }

    httpServer.once('error', onError)
    httpServer.once('listening', onListening)
    httpServer.listen(HTTP_PORT, HTTP_HOST)
  })

  console.error(
    `[${SERVER_NAME}] HTTP server started on http://${HTTP_HOST}:${HTTP_PORT}`,
  )
  console.error(
    `[${SERVER_NAME}] Streamable HTTP endpoint: ${MCP_HTTP_PATH} (GET/POST/DELETE)`,
  )
  console.error(
    `[${SERVER_NAME}] Deprecated SSE endpoints: ${MCP_SSE_PATH} (GET), ${MCP_MESSAGES_PATH} (POST)`,
  )
}

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  if (TRANSPORT_MODE === 'http') {
    await startHttpServer()
    return
  }

  await startStdioServer()
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`[${SERVER_NAME}] Fatal error:`, err)
    process.exit(1)
  })
}
