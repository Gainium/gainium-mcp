/**
 * Agent usability regression tests.
 *
 * These tests verify that tool descriptions, input schemas, and error messages
 * remain sufficient for an AI agent to complete full workflows without consulting
 * external API docs. Run after any edit to server.ts to catch regressions.
 */

import { describe, it, expect } from 'vitest'
import {
  validateBacktestPayloadShape,
  validateToolArgs,
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

// ── validateBacktestPayloadShape ─────────────────────────────────────────────

describe('validateBacktestPayloadShape', () => {
  it('throws when payload is missing, with Recovery hint', () => {
    expect(() => validateBacktestPayloadShape({})).toThrow(/payload/)
    expect(() => validateBacktestPayloadShape({})).toThrow(
      /build_backtest_payload_template/,
    )
    expect(() => validateBacktestPayloadShape({})).toThrow(
      /"missingField":"payload"/,
    )
  })

  it('throws when payload.data is missing, with Recovery hint', () => {
    // payload must be non-empty (hasKeys check) but missing the 'data' key
    const args = { payload: { _placeholder: true } }
    expect(() => validateBacktestPayloadShape(args)).toThrow(/payload\.data/)
    expect(() => validateBacktestPayloadShape(args)).toThrow(
      /"missingObject":"payload\.data"/,
    )
  })

  it('throws when exchange is missing, with suggestedTools hint', () => {
    expect(() =>
      validateBacktestPayloadShape({
        payload: { data: { exchangeUUID: 'x', settings: { a: 1 } } },
      }),
    ).toThrow(/"missingField":"payload\.data\.exchange"/)
    expect(() =>
      validateBacktestPayloadShape({
        payload: { data: { exchangeUUID: 'x', settings: { a: 1 } } },
      }),
    ).toThrow(/get_supported_exchanges|get_user_exchanges/)
  })

  it('throws when exchangeUUID is missing, with suggestedTools hint', () => {
    expect(() =>
      validateBacktestPayloadShape({
        payload: { data: { exchange: 'binance', settings: { a: 1 } } },
      }),
    ).toThrow(/"missingField":"payload\.data\.exchangeUUID"/)
    expect(() =>
      validateBacktestPayloadShape({
        payload: { data: { exchange: 'binance', settings: { a: 1 } } },
      }),
    ).toThrow(/get_user_exchanges/)
  })

  it('throws when settings is missing, with suggestedTools hint', () => {
    expect(() =>
      validateBacktestPayloadShape({
        payload: {
          data: { exchange: 'binance', exchangeUUID: 'uuid-x', settings: {} },
        },
      }),
    ).toThrow(/"missingObject":"payload\.data\.settings"/)
    expect(() =>
      validateBacktestPayloadShape({
        payload: {
          data: { exchange: 'binance', exchangeUUID: 'uuid-x', settings: {} },
        },
      }),
    ).toThrow(/get_discovery_bot|build_backtest_payload_template/)
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

  it('payload is an object type', () => {
    expect(param.type).toBe('object')
  })

  it('payload requires data', () => {
    expect(param.required).toContain('data')
  })

  it('payload.data requires exchange, exchangeUUID, settings', () => {
    const data = param.properties.data
    expect(data.required).toContain('exchange')
    expect(data.required).toContain('exchangeUUID')
    expect(data.required).toContain('settings')
  })

  it('payload.data.exchange describes get_supported_exchanges / get_user_exchanges', () => {
    const desc: string = param.properties.data.properties.exchange.description
    expect(desc).toMatch(/get_supported_exchanges|get_user_exchanges/)
  })

  it('payload.data.interval has enum values', () => {
    const interval = param.properties.data.properties.interval
    expect(interval.enum).toContain('1h')
    expect(interval.enum).toContain('1d')
  })
})

// ── Backtest tool descriptions ────────────────────────────────────────────────

const BACKTEST_TOOLS = [
  'estimate_backtest_cost',
  'request_backtest',
  'request_backtest_sync',
  'validate_backtest_payload',
]

describe.each(BACKTEST_TOOLS)('tool "%s" description', (toolName) => {
  it('mentions DCA example with BTC_USDT pair array', () => {
    const desc = findTool(toolName).description as string
    expect(desc).toContain('"BTC_USDT"')
    expect(desc).toContain('"dca"')
  })

  it('mentions Combo minimal settings', () => {
    const desc = findTool(toolName).description as string
    expect(desc.toLowerCase()).toContain('combo')
    expect(desc).toContain('gridLevel')
  })

  it('mentions Grid minimal settings and notes pair is a single string', () => {
    const desc = findTool(toolName).description as string
    expect(desc.toLowerCase()).toContain('grid')
    expect(desc).toContain('topPrice')
    expect(desc).toMatch(/grid pair is a single string/i)
  })

  it('references build_backtest_payload_template', () => {
    const desc = findTool(toolName).description as string
    expect(desc).toContain('build_backtest_payload_template')
  })

  it('uses nested backtestPayloadParam schema (not flat)', () => {
    const schema = findTool(toolName).inputSchema as any
    const payload = schema.properties?.payload
    expect(payload).toBeDefined()
    expect(payload.properties?.data).toBeDefined()
    expect(payload.properties.data.required).toContain('settings')
  })
})

// ── get_user_exchanges ────────────────────────────────────────────────────────

describe('get_user_exchanges description', () => {
  it('mentions exchangeUUID', () => {
    const desc = findTool('get_user_exchanges').description as string
    expect(desc).toContain('exchangeUUID')
  })

  it('tells agent to call it first for bot creation / backtest', () => {
    const desc = findTool('get_user_exchanges').description as string
    expect(desc).toMatch(/bot creation|create bot|workflow|first/i)
  })
})

// ── get_discovery_bot ─────────────────────────────────────────────────────────

describe('get_discovery_bot description', () => {
  it('documents pair underscore format', () => {
    const desc = findTool('get_discovery_bot').description as string
    expect(desc).toContain('BTC_USDT')
  })

  it('distinguishes array (DCA/Combo) vs single string (Grid) for pair', () => {
    const desc = findTool('get_discovery_bot').description as string
    expect(desc).toMatch(/array|DCA|Combo/i)
    expect(desc).toMatch(/Grid|single string/i)
  })
})

// ── build_backtest_payload_template ───────────────────────────────────────────

describe('build_backtest_payload_template tool', () => {
  it('exists', () => {
    expect(() => findTool('build_backtest_payload_template')).not.toThrow()
  })

  it('accepts botType and optional exchange params', () => {
    const schema = findTool('build_backtest_payload_template')
      .inputSchema as any
    expect(schema.properties).toHaveProperty('botType')
    expect(schema.properties).toHaveProperty('exchange')
    expect(schema.required).toContain('botType')
    expect(schema.required).not.toContain('exchange')
  })
})

// ── get_backtest_operation_schema ─────────────────────────────────────────────

describe('get_backtest_operation_schema tool', () => {
  it('exists', () => {
    expect(() => findTool('get_backtest_operation_schema')).not.toThrow()
  })

  it('accepts botType param', () => {
    const schema = findTool('get_backtest_operation_schema').inputSchema as any
    expect(schema.properties).toHaveProperty('botType')
    expect(schema.required).toContain('botType')
  })
})

// ── gainium://workflow resource ───────────────────────────────────────────────

describe('WORKFLOW_RESOURCE_TEXT', () => {
  it('URI is gainium://workflow', () => {
    expect(WORKFLOW_RESOURCE_URI).toBe('gainium://workflow')
  })

  it('contains the three-layer model explanation', () => {
    expect(WORKFLOW_RESOURCE_TEXT).toContain('Layer 1')
    expect(WORKFLOW_RESOURCE_TEXT).toContain('Layer 2')
    expect(WORKFLOW_RESOURCE_TEXT).toContain('Layer 3')
  })

  it('documents underscore pair format', () => {
    expect(WORKFLOW_RESOURCE_TEXT).toContain('BTC_USDT')
    expect(WORKFLOW_RESOURCE_TEXT).toMatch(/underscore/i)
  })

  it('documents array vs single string distinction for pair', () => {
    expect(WORKFLOW_RESOURCE_TEXT).toMatch(/DCA.*array|array.*DCA/i)
    expect(WORKFLOW_RESOURCE_TEXT).toMatch(
      /Grid.*single string|single string.*Grid/i,
    )
  })

  it('contains backtest recommended flow with all key steps', () => {
    expect(WORKFLOW_RESOURCE_TEXT).toContain('get_user_exchanges')
    expect(WORKFLOW_RESOURCE_TEXT).toContain('build_backtest_payload_template')
    expect(WORKFLOW_RESOURCE_TEXT).toContain('validate_backtest_payload')
    expect(WORKFLOW_RESOURCE_TEXT).toContain('estimate_backtest_cost')
    expect(WORKFLOW_RESOURCE_TEXT).toContain('request_backtest_sync')
  })

  it('documents boolean gates', () => {
    expect(WORKFLOW_RESOURCE_TEXT).toMatch(/boolean gate/i)
    expect(WORKFLOW_RESOURCE_TEXT).toContain('useDca')
    expect(WORKFLOW_RESOURCE_TEXT).toContain('useTp')
    expect(WORKFLOW_RESOURCE_TEXT).toContain('useSl')
    expect(WORKFLOW_RESOURCE_TEXT).toContain('moveSL')
  })

  it('has DECISION RULE directing agent to stop_bot instead of close_deal loop', () => {
    expect(WORKFLOW_RESOURCE_TEXT).toMatch(/DECISION RULE/i)
    expect(WORKFLOW_RESOURCE_TEXT).toMatch(
      /do not close deals.*one by one|not.*close.*loop/i,
    )
    expect(WORKFLOW_RESOURCE_TEXT).toContain('stop_bot')
    expect(WORKFLOW_RESOURCE_TEXT).toContain('closeByMarket')
  })

  it('close_deal entry warns against using it to stop a bot', () => {
    expect(WORKFLOW_RESOURCE_TEXT).toMatch(
      /close_deal.*only.*single|only.*single.*deal/i,
    )
    expect(WORKFLOW_RESOURCE_TEXT).toMatch(
      /do not.*close_deal.*loop|not.*loop/i,
    )
  })
})

// ── Boolean gate enforcement (validateToolArgs) ───────────────────────────────

const UPDATE_TOOLS = [
  'update_dca_bot',
  'update_combo_bot',
  'update_dca_deal',
  'update_combo_deal',
  'update_terminal_deal',
]

describe.each(UPDATE_TOOLS)('boolean gate enforcement — %s', (toolName) => {
  const idField = toolName.includes('deal') ? 'dealId' : 'botId'
  const baseArgs = { [idField]: 'abc123' }

  it('throws when ordersCount is set without useDca', () => {
    expect(() =>
      validateToolArgs(toolName, { ...baseArgs, settings: { ordersCount: 3 } }),
    ).toThrow(/useDca/)
  })

  it('throws when orderSize is set without useDca', () => {
    expect(() =>
      validateToolArgs(toolName, {
        ...baseArgs,
        settings: { orderSize: '200' },
      }),
    ).toThrow(/useDca/)
  })

  it('throws when tpPerc is set without useTp', () => {
    expect(() =>
      validateToolArgs(toolName, { ...baseArgs, settings: { tpPerc: '2.5' } }),
    ).toThrow(/useTp/)
  })

  it('throws when slPerc is set without useSl', () => {
    expect(() =>
      validateToolArgs(toolName, { ...baseArgs, settings: { slPerc: '-10' } }),
    ).toThrow(/useSl/)
  })

  it('does not throw when useDca:true accompanies ordersCount+orderSize', () => {
    expect(() =>
      validateToolArgs(toolName, {
        ...baseArgs,
        settings: { useDca: true, ordersCount: 1, orderSize: '200' },
      }),
    ).not.toThrow()
  })

  it('does not throw when useTp:true accompanies tpPerc', () => {
    expect(() =>
      validateToolArgs(toolName, {
        ...baseArgs,
        settings: { useTp: true, tpPerc: '2' },
      }),
    ).not.toThrow()
  })

  it('does not throw when useSl:true accompanies slPerc', () => {
    expect(() =>
      validateToolArgs(toolName, {
        ...baseArgs,
        settings: { useSl: true, slPerc: '-5' },
      }),
    ).not.toThrow()
  })
})

describe('boolean gate enforcement — moveSL / closeByTimer / trailingTpPerc / multiTp / multiSl', () => {
  it('throws when moveSLTrigger is set without moveSL on update_dca_bot', () => {
    expect(() =>
      validateToolArgs('update_dca_bot', {
        botId: 'abc',
        settings: { moveSLTrigger: '1.0' },
      }),
    ).toThrow(/moveSL/)
  })

  it('throws when moveSLForAll is set without moveSL', () => {
    expect(() =>
      validateToolArgs('update_dca_deal', {
        dealId: 'abc',
        settings: { moveSLForAll: true },
      }),
    ).toThrow(/moveSL/)
  })

  it('throws when trailingTpPerc is set without trailingTp', () => {
    expect(() =>
      validateToolArgs('update_dca_deal', {
        dealId: 'abc',
        settings: { useTp: true, trailingTpPerc: '0.5' },
      }),
    ).toThrow(/trailingTp/)
  })

  it('throws when multiTp is set without useMultiTp', () => {
    expect(() =>
      validateToolArgs('update_dca_bot', {
        botId: 'abc',
        settings: { useTp: true, multiTp: [{ perc: '1' }] },
      }),
    ).toThrow(/useMultiTp/)
  })

  it('throws when multiSl is set without useMultiSl', () => {
    expect(() =>
      validateToolArgs('update_dca_bot', {
        botId: 'abc',
        settings: { useSl: true, multiSl: [{ perc: '5' }] },
      }),
    ).toThrow(/useMultiSl/)
  })

  it('throws when closeByTimerValue is set without closeByTimer', () => {
    expect(() =>
      validateToolArgs('update_dca_deal', {
        dealId: 'abc',
        settings: { closeByTimerValue: 60 },
      }),
    ).toThrow(/closeByTimer/)
  })

  it('does not throw when moveSL:true accompanies moveSLTrigger+moveSLValue+moveSLForAll', () => {
    expect(() =>
      validateToolArgs('update_dca_bot', {
        botId: 'abc',
        settings: {
          moveSL: true,
          moveSLTrigger: '1.0',
          moveSLValue: '0.5',
          moveSLForAll: true,
        },
      }),
    ).not.toThrow()
  })

  it('does not throw when trailingTp:true accompanies trailingTpPerc (within useTp)', () => {
    expect(() =>
      validateToolArgs('update_dca_deal', {
        dealId: 'abc',
        settings: { useTp: true, trailingTp: true, trailingTpPerc: '0.5' },
      }),
    ).not.toThrow()
  })

  it('does not throw when closeByTimer:true accompanies closeByTimerValue+closeByTimerUnits', () => {
    expect(() =>
      validateToolArgs('update_dca_deal', {
        dealId: 'abc',
        settings: {
          closeByTimer: true,
          closeByTimerValue: 60,
          closeByTimerUnits: 'minutes',
        },
      }),
    ).not.toThrow()
  })
})

describe('close_deal tool description', () => {
  const tool = tools.find((t) => t.name === 'close_deal')!

  it('warns against using close_deal loop to stop a bot', () => {
    expect(tool.description).toMatch(/do not.*close_deal.*loop|not.*loop/i)
  })

  it('directs agent to stop_bot with closeByMarket instead', () => {
    expect(tool.description).toContain('stop_bot')
    expect(tool.description).toContain('closeByMarket')
  })
})

describe('stop_bot tool schema', () => {
  const tool = tools.find((t) => t.name === 'stop_bot')!

  it('exists', () => {
    expect(tool).toBeDefined()
  })

  it('closeType is in required array', () => {
    expect(tool.inputSchema.required).toContain('closeType')
  })

  it('has closeType param with all enum values', () => {
    const closeType = tool.inputSchema.properties?.closeType as any
    expect(closeType).toBeDefined()
    expect(closeType.enum).toContain('closeByMarket')
    expect(closeType.enum).toContain('leave')
    expect(closeType.enum).toContain('closeByLimit')
    expect(closeType.enum).toContain('cancel')
  })

  it('has closeGridType param for Grid bots', () => {
    const closeGridType = tool.inputSchema.properties?.closeGridType as any
    expect(closeGridType).toBeDefined()
    expect(closeGridType.enum).toContain('closeByMarket')
    expect(closeGridType.enum).toContain('cancel')
  })

  it('has cancelPartiallyFilled boolean param', () => {
    const param = tool.inputSchema.properties?.cancelPartiallyFilled as any
    expect(param).toBeDefined()
    expect(param.type).toBe('boolean')
  })

  it('description states closeType is REQUIRED', () => {
    expect(tool.description).toMatch(/closeType.*REQUIRED|REQUIRED.*closeType/i)
  })

  it('description maps "close by market" intent to closeByMarket', () => {
    expect(tool.description).toContain('closeByMarket')
    expect(tool.description).toMatch(
      /close.*market.*closeType.*closeByMarket|closeType.*closeByMarket/i,
    )
  })

  it('description includes concrete example with closeType', () => {
    expect(tool.description).toContain('"closeType"')
    expect(tool.description).toContain('"botType"')
  })

  it('workflow resource mentions closeByMarket for stop_bot', () => {
    expect(WORKFLOW_RESOURCE_TEXT).toContain('closeByMarket')
  })
})

describe('stop_bot validateToolArgs enforcement', () => {
  it('throws when closeType is missing for dca bot', () => {
    expect(() =>
      validateToolArgs('stop_bot', { botId: 'abc', botType: 'dca' }),
    ).toThrow(/closeType.*required/i)
  })

  it('throws when closeType is missing for combo bot', () => {
    expect(() =>
      validateToolArgs('stop_bot', { botId: 'abc', botType: 'combo' }),
    ).toThrow(/closeType.*required/i)
  })

  it('throws when closeType has invalid value', () => {
    expect(() =>
      validateToolArgs('stop_bot', {
        botId: 'abc',
        botType: 'dca',
        closeType: 'immediately',
      }),
    ).toThrow(/closeType.*must be one of/i)
  })

  it('throws when closeGridType is missing for grid bot', () => {
    expect(() =>
      validateToolArgs('stop_bot', { botId: 'abc', botType: 'grid' }),
    ).toThrow(/closeGridType.*required/i)
  })

  it('does not throw for dca bot with closeType=closeByMarket', () => {
    expect(() =>
      validateToolArgs('stop_bot', {
        botId: 'abc',
        botType: 'dca',
        closeType: 'closeByMarket',
      }),
    ).not.toThrow()
  })

  it('does not throw for dca bot with closeType=leave', () => {
    expect(() =>
      validateToolArgs('stop_bot', {
        botId: 'abc',
        botType: 'dca',
        closeType: 'leave',
      }),
    ).not.toThrow()
  })

  it('does not throw for grid bot with closeGridType=closeByMarket', () => {
    expect(() =>
      validateToolArgs('stop_bot', {
        botId: 'abc',
        botType: 'grid',
        closeGridType: 'closeByMarket',
      }),
    ).not.toThrow()
  })
})
