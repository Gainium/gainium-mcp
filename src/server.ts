#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
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
const SERVER_VERSION = '3.0.0'

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

function createGainiumClientFromHeaders(
  headers: IsomorphicHeaders | undefined,
): GainiumClient {
  const apiKey = getRequestHeader(headers, 'x-api-key') || API_KEY
  const apiSecret = getRequestHeader(headers, 'x-api-secret') || API_SECRET

  if (!apiKey || !apiSecret) {
    throw new Error(
      "Missing Gainium credentials. Provide 'X-API-Key' and 'X-API-Secret' request headers for hosted HTTP mode, or set GAINIUM_API_KEY and GAINIUM_API_SECRET for local stdio mode.",
    )
  }

  return new GainiumClient(BASE_URL, apiKey, apiSecret)
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
  const validDealTypes = ['dca', 'combo', 'terminal']

  // Tools that require botType
  if (
    [
      'list_bots',
      'get_bot',
      'create_bot',
      'update_bot',
      'clone_bot',
    ].includes(name)
  ) {
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
      "Grid bots do not have an update endpoint. To modify a grid bot, stop it and create a new one.",
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
    description: 'Bot ID — MongoDB ObjectId',
  },
}

const dealIdRequired = {
  dealId: {
    type: 'string' as const,
    description: 'Deal ID — MongoDB ObjectId',
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

// ── Tool Definitions ────────────────────────────────────────────────────────

export const tools: Tool[] = [
  // ─── Bots ───────────────────────────────────────────────────────────────

  {
    name: 'list_bots',
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
  },

  {
    name: 'get_bot',
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
  },

  {
    name: 'create_bot',
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
            'New trading pairs for changePairs action (DCA only), e.g. ["BTC_USDT"]',
        },
      },
      required: ['action', 'botId', 'botType'],
    },
  },

  // ─── Deals ───────────────────────────────────────────────────────────────

  {
    name: 'list_deals',
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
  },

  {
    name: 'get_deal',
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
  },

  {
    name: 'create_deal',
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
          description: 'Quantity to add or reduce',
        },
        type: {
          type: 'string',
          enum: ['fixed', 'perc'],
          description: 'Type: fixed amount or percentage',
        },
        asset: {
          type: 'string',
          description: 'Asset name (required when type=fixed)',
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
          description: 'Exchange code for template (optional, default: binance)',
        },
      },
      required: ['target', 'botType'],
    },
  },

  // ─── Discovery ───────────────────────────────────────────────────────────

  {
    name: 'discover',
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
  },

  // ─── Account & Settings ──────────────────────────────────────────────────

  {
    name: 'get_account',
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
  },

  {
    name: 'manage_global_variable',
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
          description: 'Variable name (required for create, optional for update)',
        },
        type: {
          type: 'string',
          enum: ['text', 'int', 'float'],
          description: 'Variable type (required for create, optional for update)',
        },
        value: {
          type: 'string',
          description: 'Variable value (required for create, optional for update)',
        },
      },
      required: ['action'],
    },
  },

  // ─── General ─────────────────────────────────────────────────────────────

  {
    name: 'get_screener',
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
          description: 'Sort field (optional)',
        },
        order: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Sort order (optional)',
        },
      },
    },
  },
]

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
      const res = await client.request('GET', `/api/v2/bots/${botType}/details`, {
        query: { botId: args.botId, fields: args.fields },
        headers: paperHeader(args),
      })
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
      const res = await client.request(
        'PUT',
        `/api/v2/bots/${botType}/${args.botId}`,
        {
          body: args.settings,
          headers: paperHeader(args),
        },
      )
      return JSON.stringify(res, null, 2)
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
            body: { pair: args.pair },
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
      const res = await client.request('GET', `/api/v2/deals/${dealType}/details`, {
        query: { dealId: args.dealId, fields: args.fields },
        headers: paperHeader(args),
      })
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
      const res = await client.request(
        'PUT',
        `/api/v2/deals/${dealType}/${args.dealId}`,
        {
          body: args.settings,
          headers: paperHeader(args),
        },
      )
      return JSON.stringify(res, null, 2)
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
        const endpoint =
          action === 'addFunds' ? 'add-funds' : 'reduce-funds'
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
                exchangeUUID: 'string — UUID from get_account(info: "exchanges")',
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
        const res = await client.request('GET', '/api/v2/discovery/indicators', {
          query: {
            action: args.action,
            exchange: args.exchange,
          },
        })
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
      const res = await client.request('GET', '/api/v2/screener', {
        query: {
          fields: args.fields,
          page: args.page,
          category: args.category,
          minMarketCap: args.minMarketCap,
          maxMarketCap: args.maxMarketCap,
          minVolume: args.minVolume,
          sort: args.sort,
          order: args.order,
        },
      })
      return JSON.stringify(res, null, 2)
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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
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
    if (uri === WORKFLOW_RESOURCE_URI) {
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
      const client = createGainiumClientFromHeaders(extra.requestInfo?.headers)
      const args = isPlainObject(toolArgs) ? { ...toolArgs } : {}
      const result = await handleToolCall(name, args, client)
      return { content: [{ type: 'text' as const, text: result }] }
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

      if (url.pathname === MCP_HTTP_PATH) {
        if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
          writeMethodNotAllowed(res, ['GET', 'POST', 'DELETE'])
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
