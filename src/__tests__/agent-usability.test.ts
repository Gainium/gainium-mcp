/**
 * Agent usability regression tests — v3 tool surface (17 consolidated tools).
 *
 * These tests verify the EXPORTED, offline-testable behavior of server.ts:
 *   - validateToolArgs discriminator + required-field + boolean-gate enforcement
 *   - validateBacktestPayloadShape nesting checks
 *   - applySettingsSafeDefaults (deal close-condition + multiTp/multiSl uuid injection)
 *   - SCREENER_SORT_KEYS pure sort-key resolution
 *   - WORKFLOW_RESOURCE_TEXT / tool descriptions stay sufficient for an agent
 *
 * All tests are OFFLINE — pure logic, no live API calls.
 * Run after any edit to server.ts to catch regressions.
 */

import { describe, it, expect } from 'vitest'
import {
  validateBacktestPayloadShape,
  validateToolArgs,
  applySettingsSafeDefaults,
  SCREENER_SORT_KEYS,
  backtestPayloadParam,
  WORKFLOW_RESOURCE_TEXT,
  WORKFLOW_RESOURCE_URI,
  tools,
} from '../server.js'

// ── Helper ────────────────────────────────────────────────────────────────────

function findTool(name: string) {
  const t = tools.find((t) => t.name === name)
  if (!t) throw new Error(`Tool '${name}' not found in tools array`)
  return t
}

// ── v3 tool surface ───────────────────────────────────────────────────────────

const V3_TOOLS = [
  'list_bots',
  'get_bot',
  'create_bot',
  'update_bot',
  'clone_bot',
  'manage_bot',
  'list_deals',
  'get_deal',
  'create_deal',
  'update_deal',
  'manage_deal',
  'run_backtest',
  'backtest_info',
  'discover',
  'get_account',
  'manage_global_variable',
  'get_screener',
  'list_presets',
  'apply_preset',
]

describe('v3 consolidated tool surface', () => {
  it('exposes exactly the 19 v3 tools', () => {
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([...V3_TOOLS].sort())
  })

  it.each(V3_TOOLS)('tool "%s" has a name, description and inputSchema', (name) => {
    const t = findTool(name)
    expect(typeof t.description).toBe('string')
    expect((t.description as string).length).toBeGreaterThan(0)
    expect(t.inputSchema).toBeDefined()
    expect((t.inputSchema as any).type).toBe('object')
  })

  it('does NOT expose any pre-v3.0.0 tool', () => {
    const removed = [
      'stop_bot',
      'closeGridType',
      'get_dca_bots',
      'update_dca_bot',
      'update_combo_bot',
      'update_dca_deal',
      'close_deal',
      'request_backtest',
      'request_backtest_sync',
      'build_backtest_payload_template',
      'get_user_exchanges',
      'get_discovery_bot',
    ]
    const names = new Set(tools.map((t) => t.name))
    for (const r of removed) expect(names.has(r)).toBe(false)
  })
})

// ── Discriminator validation ──────────────────────────────────────────────────

describe('validateToolArgs — botType discriminator', () => {
  it('list_bots / get_bot require botType', () => {
    expect(() => validateToolArgs('list_bots', {})).toThrow(/botType.*required/i)
    expect(() => validateToolArgs('get_bot', { botId: 'x' })).toThrow(
      /botType.*required/i,
    )
  })

  it('rejects an invalid botType', () => {
    expect(() => validateToolArgs('list_bots', { botType: 'futures' })).toThrow(
      /Invalid botType/i,
    )
  })

  it('create_bot / update_bot / clone_bot require a valid botType', () => {
    for (const name of ['create_bot', 'update_bot', 'clone_bot']) {
      expect(() => validateToolArgs(name, {})).toThrow(/botType.*required/i)
    }
  })

  it('accepts dca/combo/grid for read tools', () => {
    for (const bt of ['dca', 'combo', 'grid']) {
      expect(() => validateToolArgs('list_bots', { botType: bt })).not.toThrow()
    }
  })
})

describe('validateToolArgs — dealType discriminator', () => {
  it('list_deals / get_deal / update_deal require dealType', () => {
    expect(() => validateToolArgs('list_deals', {})).toThrow(
      /dealType.*required/i,
    )
    expect(() => validateToolArgs('get_deal', { dealId: 'x' })).toThrow(
      /dealType.*required/i,
    )
  })

  it('rejects an invalid dealType', () => {
    expect(() =>
      validateToolArgs('list_deals', { dealType: 'spot' }),
    ).toThrow(/Invalid dealType/i)
  })

  it('accepts dca/combo/terminal', () => {
    for (const dt of ['dca', 'combo', 'terminal']) {
      expect(() =>
        validateToolArgs('list_deals', { dealType: dt }),
      ).not.toThrow()
    }
  })
})

describe('validateToolArgs — required IDs', () => {
  it('get_bot / update_bot / clone_bot require botId', () => {
    expect(() =>
      validateToolArgs('get_bot', { botType: 'dca' }),
    ).toThrow(/botId.*required/i)
    expect(() =>
      validateToolArgs('clone_bot', { botType: 'dca' }),
    ).toThrow(/botId.*required/i)
  })

  it('get_deal / update_deal require dealId', () => {
    expect(() =>
      validateToolArgs('get_deal', { dealType: 'dca' }),
    ).toThrow(/dealId.*required/i)
  })
})

describe('validateToolArgs — get_account info discriminator', () => {
  it('requires info', () => {
    expect(() => validateToolArgs('get_account', {})).toThrow(
      /info.*required/i,
    )
  })

  it('rejects an invalid info value', () => {
    expect(() =>
      validateToolArgs('get_account', { info: 'positions' }),
    ).toThrow(/Invalid info/i)
  })

  it('accepts balances/exchanges/globalVariables/supportedExchanges', () => {
    for (const info of [
      'balances',
      'exchanges',
      'globalVariables',
      'supportedExchanges',
    ]) {
      expect(() => validateToolArgs('get_account', { info })).not.toThrow()
    }
  })
})

// ── update_bot: grid rejection + empty settings ───────────────────────────────

describe('validateToolArgs — update_bot', () => {
  it('rejects grid bots (no update endpoint)', () => {
    expect(() =>
      validateToolArgs('update_bot', {
        botType: 'grid',
        botId: 'abc',
        settings: { tpPerc: '1' },
      }),
    ).toThrow(/Grid bots do not have an update endpoint/i)
  })

  it('rejects missing/empty settings', () => {
    expect(() =>
      validateToolArgs('update_bot', { botType: 'dca', botId: 'abc' }),
    ).toThrow(/settings.*non-empty/i)
    expect(() =>
      validateToolArgs('update_bot', {
        botType: 'dca',
        botId: 'abc',
        settings: {},
      }),
    ).toThrow(/settings.*non-empty/i)
  })

  it('accepts a non-empty, gate-consistent settings object', () => {
    expect(() =>
      validateToolArgs('update_bot', {
        botType: 'dca',
        botId: 'abc',
        settings: { name: 'renamed' },
      }),
    ).not.toThrow()
  })
})

describe('validateToolArgs — update_deal empty settings', () => {
  it('rejects missing/empty settings', () => {
    expect(() =>
      validateToolArgs('update_deal', { dealType: 'dca', dealId: 'abc' }),
    ).toThrow(/settings.*non-empty/i)
  })
})

// ── Boolean gate enforcement ──────────────────────────────────────────────────

// Both update_bot and update_deal run the same gate logic. Provide the right
// discriminator + id for each.
const GATE_CASES = [
  { tool: 'update_bot', extra: { botType: 'dca', botId: 'abc' } },
  { tool: 'update_deal', extra: { dealType: 'dca', dealId: 'abc' } },
] as const

describe.each(GATE_CASES)('boolean gates — $tool', ({ tool, extra }) => {
  const call = (settings: Record<string, any>) =>
    validateToolArgs(tool, { ...extra, settings })

  it('useDca gates ordersCount', () => {
    expect(() => call({ ordersCount: 3 })).toThrow(/useDca/)
  })

  it('useDca gates orderSize', () => {
    expect(() => call({ orderSize: '200' })).toThrow(/useDca/)
  })

  it('useTp gates tpPerc', () => {
    expect(() => call({ tpPerc: '2.5' })).toThrow(/useTp/)
  })

  it('useSl gates slPerc', () => {
    expect(() => call({ slPerc: '-10' })).toThrow(/useSl/)
  })

  it('moveSL gates moveSLTrigger', () => {
    expect(() => call({ moveSLTrigger: '1.0' })).toThrow(/moveSL/)
  })

  it('moveSL gates moveSLForAll', () => {
    expect(() => call({ moveSLForAll: true })).toThrow(/moveSL/)
  })

  it('closeByTimer gates closeByTimerValue', () => {
    expect(() => call({ closeByTimerValue: 60 })).toThrow(/closeByTimer/)
  })

  it('useMultiTp gates multiTp (within useTp)', () => {
    expect(() =>
      call({ useTp: true, multiTp: [{ perc: '1' }] }),
    ).toThrow(/useMultiTp/)
  })

  it('useMultiSl gates multiSl (within useSl)', () => {
    expect(() =>
      call({ useSl: true, multiSl: [{ perc: '5' }] }),
    ).toThrow(/useMultiSl/)
  })

  it('trailingTp gates trailingTpPerc (within useTp)', () => {
    expect(() =>
      call({ useTp: true, trailingTpPerc: '0.5' }),
    ).toThrow(/trailingTp/)
  })

  // Happy paths — gate set in the same call.
  it('passes when useDca:true accompanies ordersCount+orderSize', () => {
    expect(() =>
      call({ useDca: true, ordersCount: 1, orderSize: '200' }),
    ).not.toThrow()
  })

  it('passes when useTp:true accompanies tpPerc', () => {
    expect(() => call({ useTp: true, tpPerc: '2' })).not.toThrow()
  })

  it('passes when useSl:true accompanies slPerc', () => {
    expect(() => call({ useSl: true, slPerc: '-5' })).not.toThrow()
  })

  it('passes when moveSL:true accompanies its value fields', () => {
    expect(() =>
      call({
        moveSL: true,
        moveSLTrigger: '1.0',
        moveSLValue: '0.5',
        moveSLForAll: true,
      }),
    ).not.toThrow()
  })

  it('passes when closeByTimer:true accompanies its value fields', () => {
    expect(() =>
      call({
        closeByTimer: true,
        closeByTimerValue: 60,
        closeByTimerUnits: 'minutes',
      }),
    ).not.toThrow()
  })

  it('passes when trailingTp:true accompanies trailingTpPerc (within useTp)', () => {
    expect(() =>
      call({ useTp: true, trailingTp: true, trailingTpPerc: '0.5' }),
    ).not.toThrow()
  })
})

// ── manage_bot validation ─────────────────────────────────────────────────────

describe('validateToolArgs — manage_bot', () => {
  it('requires action, botId, botType', () => {
    expect(() => validateToolArgs('manage_bot', {})).toThrow(
      /action.*required/i,
    )
    expect(() =>
      validateToolArgs('manage_bot', { action: 'start' }),
    ).toThrow(/botId.*required/i)
    expect(() =>
      validateToolArgs('manage_bot', { action: 'start', botId: 'abc' }),
    ).toThrow(/botType.*required/i)
  })

  it('stop (dca/combo) requires a valid closeType', () => {
    expect(() =>
      validateToolArgs('manage_bot', {
        action: 'stop',
        botId: 'abc',
        botType: 'dca',
      }),
    ).toThrow(/closeType.*required/i)
    expect(() =>
      validateToolArgs('manage_bot', {
        action: 'stop',
        botId: 'abc',
        botType: 'dca',
        closeType: 'immediately',
      }),
    ).toThrow(/closeType.*must be one of/i)
  })

  it('stop (grid) requires a valid closeGridType', () => {
    expect(() =>
      validateToolArgs('manage_bot', {
        action: 'stop',
        botId: 'abc',
        botType: 'grid',
      }),
    ).toThrow(/closeGridType.*required/i)
    expect(() =>
      validateToolArgs('manage_bot', {
        action: 'stop',
        botId: 'abc',
        botType: 'grid',
        closeGridType: 'leave',
      }),
    ).toThrow(/closeGridType.*must be one of/i)
  })

  it('stop passes for dca with closeType=closeByMarket', () => {
    expect(() =>
      validateToolArgs('manage_bot', {
        action: 'stop',
        botId: 'abc',
        botType: 'dca',
        closeType: 'closeByMarket',
      }),
    ).not.toThrow()
  })

  it('stop passes for grid with closeGridType=closeByMarket', () => {
    expect(() =>
      validateToolArgs('manage_bot', {
        action: 'stop',
        botId: 'abc',
        botType: 'grid',
        closeGridType: 'closeByMarket',
      }),
    ).not.toThrow()
  })

  it('changePairs is dca-only and requires a non-empty pair array', () => {
    expect(() =>
      validateToolArgs('manage_bot', {
        action: 'changePairs',
        botId: 'abc',
        botType: 'combo',
        pair: ['BTC_USDT'],
      }),
    ).toThrow(/only supported for dca/i)
    expect(() =>
      validateToolArgs('manage_bot', {
        action: 'changePairs',
        botId: 'abc',
        botType: 'dca',
        pair: [],
      }),
    ).toThrow(/pair.*non-empty array/i)
    expect(() =>
      validateToolArgs('manage_bot', {
        action: 'changePairs',
        botId: 'abc',
        botType: 'dca',
        pair: ['BTC_USDT'],
      }),
    ).not.toThrow()
  })

  it('start passes (no closeType needed)', () => {
    expect(() =>
      validateToolArgs('manage_bot', {
        action: 'start',
        botId: 'abc',
        botType: 'dca',
      }),
    ).not.toThrow()
  })
})

// ── manage_deal validation ────────────────────────────────────────────────────

describe('validateToolArgs — manage_deal', () => {
  it('requires action, dealId, dealType', () => {
    expect(() => validateToolArgs('manage_deal', {})).toThrow(
      /action.*required/i,
    )
    expect(() =>
      validateToolArgs('manage_deal', { action: 'close' }),
    ).toThrow(/dealId.*required/i)
    expect(() =>
      validateToolArgs('manage_deal', { action: 'close', dealId: 'abc' }),
    ).toThrow(/dealType.*required/i)
  })

  it('close requires closeType', () => {
    expect(() =>
      validateToolArgs('manage_deal', {
        action: 'close',
        dealId: 'abc',
        dealType: 'dca',
      }),
    ).toThrow(/closeType.*required/i)
  })

  it('addFunds requires qty, and asset when type=fixed', () => {
    expect(() =>
      validateToolArgs('manage_deal', {
        action: 'addFunds',
        dealId: 'abc',
        dealType: 'dca',
      }),
    ).toThrow(/qty.*required/i)
    expect(() =>
      validateToolArgs('manage_deal', {
        action: 'addFunds',
        dealId: 'abc',
        dealType: 'dca',
        qty: '10',
        type: 'fixed',
      }),
    ).toThrow(/asset.*required/i)
    expect(() =>
      validateToolArgs('manage_deal', {
        action: 'addFunds',
        dealId: 'abc',
        dealType: 'dca',
        qty: '10',
        type: 'fixed',
        asset: 'USDT',
      }),
    ).not.toThrow()
  })

  it('close passes with closeType present', () => {
    expect(() =>
      validateToolArgs('manage_deal', {
        action: 'close',
        dealId: 'abc',
        dealType: 'dca',
        closeType: 'closeByMarket',
      }),
    ).not.toThrow()
  })
})

// ── create_deal validation ────────────────────────────────────────────────────

describe('validateToolArgs — create_deal', () => {
  it('requires dealType', () => {
    expect(() => validateToolArgs('create_deal', {})).toThrow(
      /dealType.*required/i,
    )
  })

  it('terminal deals require exchangeUUID and terminalDealType', () => {
    expect(() =>
      validateToolArgs('create_deal', { dealType: 'terminal' }),
    ).toThrow(/exchangeUUID.*required/i)
    expect(() =>
      validateToolArgs('create_deal', {
        dealType: 'terminal',
        exchangeUUID: 'uuid-x',
      }),
    ).toThrow(/terminalDealType.*required/i)
  })

  it('dca/combo deals require botId', () => {
    expect(() =>
      validateToolArgs('create_deal', { dealType: 'dca' }),
    ).toThrow(/botId.*required/i)
    expect(() =>
      validateToolArgs('create_deal', { dealType: 'dca', botId: 'abc' }),
    ).not.toThrow()
  })
})

// ── run_backtest validation ───────────────────────────────────────────────────

describe('validateToolArgs — run_backtest', () => {
  const goodPayload = {
    payload: {
      data: {
        exchange: 'binance',
        exchangeUUID: 'uuid-x',
        settings: { pair: ['BTC_USDT'], strategy: 'LONG' },
      },
    },
  }

  it('requires a valid mode', () => {
    expect(() =>
      validateToolArgs('run_backtest', { botType: 'dca', ...goodPayload }),
    ).toThrow(/mode.*required/i)
    expect(() =>
      validateToolArgs('run_backtest', {
        mode: 'run',
        botType: 'dca',
        ...goodPayload,
      }),
    ).toThrow(/Invalid mode/i)
  })

  it('requires botType', () => {
    expect(() =>
      validateToolArgs('run_backtest', { mode: 'validate', ...goodPayload }),
    ).toThrow(/botType.*required/i)
  })

  it('validates the payload shape', () => {
    expect(() =>
      validateToolArgs('run_backtest', {
        mode: 'validate',
        botType: 'dca',
        payload: {},
      }),
    ).toThrow(/payload/)
  })

  it('passes for a well-formed request', () => {
    for (const mode of ['validate', 'estimate', 'request', 'requestSync']) {
      expect(() =>
        validateToolArgs('run_backtest', {
          mode,
          botType: 'dca',
          ...goodPayload,
        }),
      ).not.toThrow()
    }
  })
})

// ── validateBacktestPayloadShape ─────────────────────────────────────────────

describe('validateBacktestPayloadShape', () => {
  it('throws when payload is missing, with Recovery hint', () => {
    expect(() => validateBacktestPayloadShape({})).toThrow(/payload/)
    expect(() => validateBacktestPayloadShape({})).toThrow(
      /"missingField":"payload"/,
    )
  })

  it('throws when payload.data is missing', () => {
    expect(() =>
      validateBacktestPayloadShape({ payload: { _placeholder: true } }),
    ).toThrow(/"missingObject":"payload\.data"/)
  })

  it('throws when exchange is missing, suggesting discover/get_account', () => {
    expect(() =>
      validateBacktestPayloadShape({
        payload: { data: { exchangeUUID: 'x', settings: { a: 1 } } },
      }),
    ).toThrow(/"missingField":"payload\.data\.exchange"/)
    expect(() =>
      validateBacktestPayloadShape({
        payload: { data: { exchangeUUID: 'x', settings: { a: 1 } } },
      }),
    ).toThrow(/discover|get_account/)
  })

  it('throws when exchangeUUID is missing', () => {
    expect(() =>
      validateBacktestPayloadShape({
        payload: { data: { exchange: 'binance', settings: { a: 1 } } },
      }),
    ).toThrow(/"missingField":"payload\.data\.exchangeUUID"/)
  })

  it('throws when settings is empty', () => {
    expect(() =>
      validateBacktestPayloadShape({
        payload: {
          data: { exchange: 'binance', exchangeUUID: 'uuid-x', settings: {} },
        },
      }),
    ).toThrow(/"missingObject":"payload\.data\.settings"/)
  })

  it('does not throw for a valid payload shape', () => {
    expect(() =>
      validateBacktestPayloadShape({
        payload: {
          data: {
            exchange: 'binance',
            exchangeUUID: '650e8400-e29b-41d4-a716-446655440001',
            settings: { pair: ['BTC_USDT'], strategy: 'LONG' },
          },
        },
      }),
    ).not.toThrow()
  })
})

// ── backtestPayloadParam schema ───────────────────────────────────────────────

describe('backtestPayloadParam — nested JSON Schema', () => {
  const param = backtestPayloadParam.payload as any

  it('payload is an object that requires data', () => {
    expect(param.type).toBe('object')
    expect(param.required).toContain('data')
  })

  it('payload.data requires exchange, exchangeUUID, settings', () => {
    const data = param.properties.data
    expect(data.required).toContain('exchange')
    expect(data.required).toContain('exchangeUUID')
    expect(data.required).toContain('settings')
  })

  it('payload.data.exchange description points at discover / get_account', () => {
    const desc: string = param.properties.data.properties.exchange.description
    expect(desc).toMatch(/discover|get_account/)
  })

  it('payload.data.interval enumerates intervals', () => {
    const interval = param.properties.data.properties.interval
    expect(interval.enum).toContain('1h')
    expect(interval.enum).toContain('1d')
  })
})

// ── applySettingsSafeDefaults ─────────────────────────────────────────────────

describe('applySettingsSafeDefaults — deal close condition', () => {
  it('injects dealCloseCondition="tp" when TP fields + useTp present and condition absent', () => {
    const settings: Record<string, any> = { useTp: true, tpPerc: '2' }
    const notes = applySettingsSafeDefaults(settings, 'deal')
    expect(settings.dealCloseCondition).toBe('tp')
    expect(notes.some((n) => /dealCloseCondition="tp"/.test(n))).toBe(true)
  })

  it('does NOT override an explicit dealCloseCondition', () => {
    const settings: Record<string, any> = {
      useTp: true,
      tpPerc: '2',
      dealCloseCondition: 'manual',
    }
    applySettingsSafeDefaults(settings, 'deal')
    expect(settings.dealCloseCondition).toBe('manual')
  })

  it('does NOT inject when useTp is not true', () => {
    const settings: Record<string, any> = { tpPerc: '2' }
    applySettingsSafeDefaults(settings, 'deal')
    expect('dealCloseCondition' in settings).toBe(false)
  })

  it('does NOT inject for kind="bot" (a bot may close by techInd/webhook)', () => {
    const settings: Record<string, any> = { useTp: true, tpPerc: '2' }
    applySettingsSafeDefaults(settings, 'bot')
    expect('dealCloseCondition' in settings).toBe(false)
  })
})

describe('applySettingsSafeDefaults — multiTp/multiSl uuid generation', () => {
  it('auto-generates a uuid for multiTp items missing one', () => {
    const settings: Record<string, any> = {
      multiTp: [{ target: '1', amount: '50' }, { target: '2', amount: '50' }],
    }
    const notes = applySettingsSafeDefaults(settings, 'deal')
    for (const item of settings.multiTp) {
      expect(typeof item.uuid).toBe('string')
      expect(item.uuid.length).toBeGreaterThan(0)
    }
    // Each generated uuid is unique.
    expect(settings.multiTp[0].uuid).not.toBe(settings.multiTp[1].uuid)
    expect(notes.some((n) => /multiTp/.test(n))).toBe(true)
  })

  it('preserves an existing uuid', () => {
    const settings: Record<string, any> = {
      multiSl: [{ target: '1', amount: '100', uuid: 'keep-me' }],
    }
    applySettingsSafeDefaults(settings, 'bot')
    expect(settings.multiSl[0].uuid).toBe('keep-me')
  })

  it('ignores non-array multiTp/multiSl', () => {
    const settings: Record<string, any> = { multiTp: 'not-an-array' }
    expect(() => applySettingsSafeDefaults(settings, 'deal')).not.toThrow()
  })

  it('returns no notes for empty settings', () => {
    expect(applySettingsSafeDefaults({}, 'deal')).toEqual([])
  })
})

// ── get_screener client-side sort keys ────────────────────────────────────────

describe('SCREENER_SORT_KEYS — pure sort key resolution', () => {
  it('volatility = absolute 24h percentage change', () => {
    const keyFn = SCREENER_SORT_KEYS['volatility']
    expect(keyFn({ priceChangePercentage24h: -7.5 })).toBe(7.5)
    expect(keyFn({ priceChangePercentage24h: 4.2 })).toBe(4.2)
    expect(keyFn({ priceChangePercentage24h: '0' })).toBe(0)
  })

  it('priceChange/change keep sign (not absolute)', () => {
    expect(SCREENER_SORT_KEYS['change']({ priceChangePercentage24h: -7.5 })).toBe(
      -7.5,
    )
    expect(
      SCREENER_SORT_KEYS['pricechange']({ priceChangePercentage24h: -3 }),
    ).toBe(-3)
  })

  it('volume / marketCap / price map to numeric fields', () => {
    expect(SCREENER_SORT_KEYS['volume']({ totalVolume: '1000' })).toBe(1000)
    expect(SCREENER_SORT_KEYS['marketcap']({ marketCap: 5e9 })).toBe(5e9)
    expect(SCREENER_SORT_KEYS['price']({ currentPrice: '42.5' })).toBe(42.5)
  })

  it('coerces missing/NaN values to 0', () => {
    expect(SCREENER_SORT_KEYS['volatility']({})).toBe(0)
    expect(SCREENER_SORT_KEYS['volume']({ totalVolume: 'abc' })).toBe(0)
  })

  it('lookup is case-insensitive (matches handler which lowercases args.sort)', () => {
    // Handler does SCREENER_SORT_KEYS[String(args.sort).toLowerCase()].
    expect(SCREENER_SORT_KEYS['VOLATILITY'.toLowerCase()]).toBeDefined()
    expect(SCREENER_SORT_KEYS['Volume'.toLowerCase()]).toBeDefined()
  })

  it('unsupported sort key resolves to undefined (handler throws on this)', () => {
    expect(SCREENER_SORT_KEYS['nonsense']).toBeUndefined()
  })

  it('sorting descending by volatility ranks the most volatile first', () => {
    const coins = [
      { symbol: 'A', priceChangePercentage24h: 2 },
      { symbol: 'B', priceChangePercentage24h: -12 },
      { symbol: 'C', priceChangePercentage24h: 5 },
    ]
    const keyFn = SCREENER_SORT_KEYS['volatility']
    const sorted = [...coins].sort((a, b) => keyFn(b) - keyFn(a))
    expect(sorted.map((c) => c.symbol)).toEqual(['B', 'C', 'A'])
  })
})

// ── gainium://workflow resource ───────────────────────────────────────────────

describe('WORKFLOW_RESOURCE_TEXT', () => {
  it('URI is gainium://workflow', () => {
    expect(WORKFLOW_RESOURCE_URI).toBe('gainium://workflow')
  })

  it('explains the three-layer model', () => {
    expect(WORKFLOW_RESOURCE_TEXT).toContain('Layer 1')
    expect(WORKFLOW_RESOURCE_TEXT).toContain('Layer 2')
    expect(WORKFLOW_RESOURCE_TEXT).toContain('Layer 3')
  })

  it('documents the underscore pair format with array vs single-string distinction', () => {
    expect(WORKFLOW_RESOURCE_TEXT).toContain('BTC_USDT')
    expect(WORKFLOW_RESOURCE_TEXT).toMatch(/underscore/i)
    expect(WORKFLOW_RESOURCE_TEXT).toMatch(/array/i)
    expect(WORKFLOW_RESOURCE_TEXT).toMatch(/grid.*single string|single string.*grid/i)
  })

  it('documents the v3 backtest flow via run_backtest modes', () => {
    expect(WORKFLOW_RESOURCE_TEXT).toContain('get_account')
    expect(WORKFLOW_RESOURCE_TEXT).toContain('run_backtest')
    expect(WORKFLOW_RESOURCE_TEXT).toContain('validate')
    expect(WORKFLOW_RESOURCE_TEXT).toContain('estimate')
    expect(WORKFLOW_RESOURCE_TEXT).toContain('requestSync')
  })

  it('documents the boolean gates', () => {
    expect(WORKFLOW_RESOURCE_TEXT).toMatch(/boolean gate/i)
    expect(WORKFLOW_RESOURCE_TEXT).toContain('useDca')
    expect(WORKFLOW_RESOURCE_TEXT).toContain('useTp')
    expect(WORKFLOW_RESOURCE_TEXT).toContain('useSl')
    expect(WORKFLOW_RESOURCE_TEXT).toContain('moveSL')
    expect(WORKFLOW_RESOURCE_TEXT).toContain('closeByTimer')
  })

  it('has a DECISION RULE steering to manage_bot stop instead of a close-deal loop', () => {
    expect(WORKFLOW_RESOURCE_TEXT).toMatch(/DECISION RULE/i)
    expect(WORKFLOW_RESOURCE_TEXT).toMatch(/do not close deals one by one/i)
    expect(WORKFLOW_RESOURCE_TEXT).toContain('manage_bot')
    expect(WORKFLOW_RESOURCE_TEXT).toContain('closeByMarket')
  })
})

// ── manage_bot tool description (agent guidance) ───────────────────────────────

describe('manage_bot tool schema', () => {
  const tool = () => findTool('manage_bot')

  it('action enum covers the bot lifecycle including stop and changePairs', () => {
    const action = (tool().inputSchema as any).properties.action
    for (const a of ['start', 'stop', 'archive', 'restore', 'changePairs']) {
      expect(action.enum).toContain(a)
    }
  })

  it('closeType enum maps the close-by-market intent to closeByMarket', () => {
    const closeType = (tool().inputSchema as any).properties.closeType
    expect(closeType.enum).toContain('closeByMarket')
    expect(closeType.enum).toContain('leave')
  })
})
