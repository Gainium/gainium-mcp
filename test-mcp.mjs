#!/usr/bin/env node
/**
 * MCP stdio integration test harness.
 * Spawns the server, sends JSON-RPC requests, and validates responses.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'

// Manually load .env
try {
  const envContent = readFileSync('.env', 'utf8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    if (!process.env[key]) process.env[key] = val
  }
} catch { /* no .env */ }

const SERVER = 'dist/server.js'
let reqId = 0
const passed = []
const failed = []

// ── Spawn server ─────────────────────────────────────────────────────────────

const proc = spawn('node', [SERVER], {
  env: { ...process.env, GAINIUM_MCP_TRANSPORT: 'stdio' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

// Collect stderr for debugging
let stderrBuf = ''
proc.stderr.on('data', (d) => { stderrBuf += d.toString() })

// Read JSON-RPC responses line by line from stdout
const rl = createInterface({ input: proc.stdout })
const pending = new Map() // id -> { resolve, timer }

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line)
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, timer } = pending.get(msg.id)
      clearTimeout(timer)
      pending.delete(msg.id)
      resolve(msg)
    }
  } catch { /* ignore non-JSON lines */ }
})

function send(method, params = {}) {
  const id = ++reqId
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
  proc.stdin.write(msg)

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Timeout waiting for response to ${method} (id=${id})`))
    }, 30000)
    pending.set(id, { resolve, timer })
  })
}

async function callTool(name, args = {}) {
  return send('tools/call', { name, arguments: args })
}

// ── Test helpers ────────────────────────────────────────────────────────────

function assert(condition, label) {
  if (condition) {
    passed.push(label)
    console.log(`  ✅ ${label}`)
  } else {
    failed.push(label)
    console.log(`  ❌ ${label}`)
  }
}

function getContent(resp) {
  if (!resp?.result?.content?.[0]?.text) return null
  return resp.result.content[0].text
}

function isErrorResponse(resp) {
  return resp?.result?.isError === true
}

function parseContent(resp) {
  const text = getContent(resp)
  if (!text) return null
  try { return JSON.parse(text) } catch { return text }
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n🔧 MCP Server Integration Tests\n')

  // 1. Initialize
  console.log('── Initialize ──')
  const initResp = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  })
  assert(initResp.result?.serverInfo?.name === 'gainium-mcp', 'Server identifies as gainium-mcp')
  assert(initResp.result?.serverInfo?.version === '3.0.0', 'Version is 3.0.0')
  assert(initResp.result?.capabilities?.tools !== undefined, 'Tools capability advertised')
  assert(initResp.result?.capabilities?.resources !== undefined, 'Resources capability advertised')

  // Send initialized notification (no response expected)
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  await new Promise(r => setTimeout(r, 500))

  // 2. List Tools
  console.log('\n── List Tools ──')
  const toolsResp = await send('tools/list')
  const toolNames = toolsResp.result?.tools?.map(t => t.name) || []
  assert(toolNames.length === 17, `Exactly 17 tools (got ${toolNames.length})`)

  const expected17 = [
    'list_bots', 'get_bot', 'create_bot', 'update_bot', 'clone_bot', 'manage_bot',
    'list_deals', 'get_deal', 'create_deal', 'update_deal', 'manage_deal',
    'run_backtest', 'backtest_info', 'discover', 'get_account',
    'manage_global_variable', 'get_screener',
  ]
  for (const name of expected17) {
    assert(toolNames.includes(name), `Tool "${name}" exists`)
  }

  // Verify schema structure for key tools
  const listBotsTool = toolsResp.result.tools.find(t => t.name === 'list_bots')
  assert(listBotsTool.inputSchema.required?.includes('botType'), 'list_bots requires botType')
  const manageBotTool = toolsResp.result.tools.find(t => t.name === 'manage_bot')
  assert(manageBotTool.inputSchema.properties?.action?.enum?.length === 5, 'manage_bot has 5 actions')
  const manageDealTool = toolsResp.result.tools.find(t => t.name === 'manage_deal')
  assert(manageDealTool.inputSchema.properties?.action?.enum?.includes('addFunds'), 'manage_deal includes addFunds')

  // 3. List Resources
  console.log('\n── List Resources ──')
  const resourcesResp = await send('resources/list')
  const resources = resourcesResp.result?.resources || []
  assert(resources.length === 1, 'One resource listed')
  assert(resources[0]?.uri === 'gainium://workflow', 'Workflow resource URI correct')

  // 4. Read Workflow Resource
  console.log('\n── Read Workflow Resource ──')
  const readResp = await send('resources/read', { uri: 'gainium://workflow' })
  const workflowText = readResp.result?.contents?.[0]?.text || ''
  assert(workflowText.includes('list_bots'), 'Workflow mentions list_bots')
  assert(workflowText.includes('manage_bot'), 'Workflow mentions manage_bot')
  assert(workflowText.includes('manage_deal'), 'Workflow mentions manage_deal')
  assert(!workflowText.includes('get_dca_bots'), 'Workflow does NOT mention old get_dca_bots')
  assert(!workflowText.includes('stop_bot'), 'Workflow does NOT mention old stop_bot')

  // 5. Validation tests (no API call needed)
  console.log('\n── Validation Tests ──')

  // Missing required botType
  const noType = await callTool('list_bots', {})
  assert(isErrorResponse(noType), 'list_bots without botType → error')
  assert(getContent(noType).includes('botType'), 'Error mentions botType')

  // Invalid botType
  const badType = await callTool('list_bots', { botType: 'invalid' })
  assert(isErrorResponse(badType), 'list_bots with invalid botType → error')

  // update_bot requires settings
  const noSettings = await callTool('update_bot', { botType: 'dca', botId: 'test123' })
  assert(isErrorResponse(noSettings), 'update_bot without settings → error')
  assert(getContent(noSettings).includes('settings'), 'Error mentions settings')

  // update_bot with empty settings
  const emptySettings = await callTool('update_bot', { botType: 'dca', botId: 'test123', settings: {} })
  assert(isErrorResponse(emptySettings), 'update_bot with empty settings → error')

  // update_bot boolean gate violation
  const gateViolation = await callTool('update_bot', {
    botType: 'dca',
    botId: 'test123',
    settings: { ordersCount: 5, orderSize: '200', step: '1.5' },  // missing useDca: true
  })
  assert(isErrorResponse(gateViolation), 'Boolean gate violation → error')
  assert(getContent(gateViolation).includes('useDca'), 'Error mentions useDca gate')

  // update_bot grid not allowed
  const gridUpdate = await callTool('update_bot', { botType: 'grid', botId: 'test123', settings: { name: 'test' } })
  assert(isErrorResponse(gridUpdate), 'update_bot with grid → error')
  assert(getContent(gridUpdate).includes('grid'), 'Error mentions grid not supported')

  // manage_bot stop without closeType
  const stopNoClose = await callTool('manage_bot', { action: 'stop', botId: 'test123', botType: 'dca' })
  assert(isErrorResponse(stopNoClose), 'manage_bot stop without closeType → error')

  // manage_bot stop grid without closeGridType
  const stopGridNoClose = await callTool('manage_bot', { action: 'stop', botId: 'test123', botType: 'grid' })
  assert(isErrorResponse(stopGridNoClose), 'manage_bot stop grid without closeGridType → error')

  // manage_bot changePairs must be DCA only
  const changePairsCombo = await callTool('manage_bot', { action: 'changePairs', botId: 'test123', botType: 'combo', pair: ['BTC_USDT'] })
  assert(isErrorResponse(changePairsCombo), 'changePairs on combo → error (DCA only)')

  // manage_bot changePairs without pair array
  const changePairsNoPair = await callTool('manage_bot', { action: 'changePairs', botId: 'test123', botType: 'dca' })
  assert(isErrorResponse(changePairsNoPair), 'changePairs without pair → error')

  // clone_bot requires botId
  const cloneNoBotId = await callTool('clone_bot', { botType: 'dca' })
  assert(isErrorResponse(cloneNoBotId), 'clone_bot without botId → error')

  // manage_deal close without required fields
  const closeNoType = await callTool('manage_deal', { action: 'close', dealId: 'test123' })
  assert(isErrorResponse(closeNoType), 'manage_deal close without dealType → error')

  // manage_deal addFunds without qty
  const addFundsNoQty = await callTool('manage_deal', { action: 'addFunds', dealType: 'dca', dealId: 'test123' })
  assert(isErrorResponse(addFundsNoQty), 'manage_deal addFunds without qty → error')

  // manage_deal addFunds fixed without asset
  const addFundsNoAsset = await callTool('manage_deal', { action: 'addFunds', dealType: 'dca', dealId: 'test123', qty: '100', type: 'fixed' })
  assert(isErrorResponse(addFundsNoAsset), 'manage_deal addFunds fixed without asset → error')

  // create_deal terminal without exchangeUUID
  const terminalNoExchange = await callTool('create_deal', { dealType: 'terminal' })
  assert(isErrorResponse(terminalNoExchange), 'create_deal terminal without exchangeUUID → error')

  // create_deal dca without botId
  const dcaDealNoBotId = await callTool('create_deal', { dealType: 'dca' })
  assert(isErrorResponse(dcaDealNoBotId), 'create_deal dca without botId → error')

  // run_backtest missing payload
  const backtestNoPayload = await callTool('run_backtest', { mode: 'validate', botType: 'dca' })
  assert(isErrorResponse(backtestNoPayload), 'run_backtest without payload → error')
  assert(getContent(backtestNoPayload).includes('payload'), 'Error mentions payload')

  // backtest_info request without id
  const backtestReqNoId = await callTool('backtest_info', { target: 'request', botType: 'dca' })
  assert(isErrorResponse(backtestReqNoId), 'backtest_info request without id → error')

  // discover bot without botType
  const discoverBotNoType = await callTool('discover', { target: 'bot' })
  assert(isErrorResponse(discoverBotNoType), 'discover bot without botType → error')

  // discover indicator without type
  const discoverIndNoType = await callTool('discover', { target: 'indicator' })
  assert(isErrorResponse(discoverIndNoType), 'discover indicator without type → error')

  // manage_global_variable create without required fields
  const gvCreateNoName = await callTool('manage_global_variable', { action: 'create', type: 'text', value: 'test' })
  assert(isErrorResponse(gvCreateNoName), 'manage_global_variable create without name → error')

  // manage_global_variable update without id
  const gvUpdateNoId = await callTool('manage_global_variable', { action: 'update', name: 'test' })
  assert(isErrorResponse(gvUpdateNoId), 'manage_global_variable update without id → error')

  // manage_global_variable delete without id
  const gvDeleteNoId = await callTool('manage_global_variable', { action: 'delete' })
  assert(isErrorResponse(gvDeleteNoId), 'manage_global_variable delete without id → error')

  // get_account balances with both asset and assets
  const balancesBothAssets = await callTool('get_account', { info: 'balances', asset: 'BTC', assets: 'BTC,ETH' })
  assert(isErrorResponse(balancesBothAssets), 'get_account balances with both asset+assets → error')

  // 6. Live API tests (read-only operations)
  console.log('\n── Live API Tests (read-only) ──')

  // list_bots dca
  const dcaBots = await callTool('list_bots', { botType: 'dca', fields: 'minimal' })
  assert(!isErrorResponse(dcaBots), 'list_bots dca → success')
  const dcaData = parseContent(dcaBots)
  assert(dcaData !== null, 'list_bots dca returns data')
  console.log(`    (got ${Array.isArray(dcaData?.data) ? dcaData.data.length : '?'} DCA bots)`)

  // list_bots combo
  const comboBots = await callTool('list_bots', { botType: 'combo', fields: 'minimal' })
  assert(!isErrorResponse(comboBots), 'list_bots combo → success')

  // list_bots grid
  const gridBots = await callTool('list_bots', { botType: 'grid', fields: 'minimal' })
  assert(!isErrorResponse(gridBots), 'list_bots grid → success')

  // list_deals dca
  const dcaDeals = await callTool('list_deals', { dealType: 'dca', fields: 'minimal' })
  assert(!isErrorResponse(dcaDeals), 'list_deals dca → success')

  // list_deals combo
  const comboDeals = await callTool('list_deals', { dealType: 'combo', fields: 'minimal' })
  assert(!isErrorResponse(comboDeals), 'list_deals combo → success')

  // list_deals terminal
  const terminalDeals = await callTool('list_deals', { dealType: 'terminal', fields: 'minimal' })
  assert(!isErrorResponse(terminalDeals), 'list_deals terminal → success')

  // get_account exchanges
  const exchanges = await callTool('get_account', { info: 'exchanges' })
  assert(!isErrorResponse(exchanges), 'get_account exchanges → success')
  const exchangeData = parseContent(exchanges)
  console.log(`    (got ${Array.isArray(exchangeData) ? exchangeData.length : '?'} exchanges)`)

  // get_account supportedExchanges
  const supportedExchanges = await callTool('get_account', { info: 'supportedExchanges' })
  assert(!isErrorResponse(supportedExchanges), 'get_account supportedExchanges → success')

  // get_account balances
  const balances = await callTool('get_account', { info: 'balances', fields: 'minimal' })
  assert(!isErrorResponse(balances), 'get_account balances → success')

  // get_account globalVariables
  const globalVars = await callTool('get_account', { info: 'globalVariables' })
  assert(!isErrorResponse(globalVars), 'get_account globalVariables → success')

  // discover bots
  const discoverBots = await callTool('discover', { target: 'bots' })
  assert(!isErrorResponse(discoverBots), 'discover bots → success')

  // discover bot dca
  const discoverDca = await callTool('discover', { target: 'bot', botType: 'dca' })
  assert(!isErrorResponse(discoverDca), 'discover bot dca → success')

  // discover botSections dca
  const discoverSections = await callTool('discover', { target: 'botSections', botType: 'dca' })
  assert(!isErrorResponse(discoverSections), 'discover botSections dca → success')

  // discover indicators
  const discoverIndicators = await callTool('discover', { target: 'indicators' })
  assert(!isErrorResponse(discoverIndicators), 'discover indicators → success')

  // discover indicator RSI
  const discoverRsi = await callTool('discover', { target: 'indicator', type: 'RSI' })
  assert(!isErrorResponse(discoverRsi), 'discover indicator RSI → success')

  // backtest_info schema
  const btSchema = await callTool('backtest_info', { target: 'schema', botType: 'dca' })
  assert(!isErrorResponse(btSchema), 'backtest_info schema → success')
  const schemaData = parseContent(btSchema)
  assert(schemaData?.operations?.length === 4, 'Schema lists 4 operations')

  // backtest_info template
  const btTemplate = await callTool('backtest_info', { target: 'template', botType: 'dca' })
  assert(!isErrorResponse(btTemplate), 'backtest_info template dca → success')
  const templateData = parseContent(btTemplate)
  assert(templateData?.payload?.data?.settings?.useDca === true, 'Template includes useDca: true')

  // backtest_info template combo
  const btTemplateCombo = await callTool('backtest_info', { target: 'template', botType: 'combo' })
  assert(!isErrorResponse(btTemplateCombo), 'backtest_info template combo → success')

  // backtest_info template grid
  const btTemplateGrid = await callTool('backtest_info', { target: 'template', botType: 'grid' })
  assert(!isErrorResponse(btTemplateGrid), 'backtest_info template grid → success')

  // backtest_info requests list
  const btRequests = await callTool('backtest_info', { target: 'requests', botType: 'dca' })
  assert(!isErrorResponse(btRequests), 'backtest_info requests dca → success')

  // get_screener
  const screener = await callTool('get_screener', { page: 1 })
  assert(!isErrorResponse(screener), 'get_screener → success')

  // 7. Test with an actual bot if available
  console.log('\n── Bot Detail Tests ──')
  const dcaBotsData = parseContent(dcaBots)
  if (dcaBotsData?.data?.length > 0) {
    const firstBot = dcaBotsData.data[0]
    const botId = firstBot._id || firstBot.uuid
    console.log(`    Using DCA bot: ${botId}`)

    const botDetail = await callTool('get_bot', { botType: 'dca', botId, fields: 'standard' })
    assert(!isErrorResponse(botDetail), 'get_bot dca detail → success')

    // list_deals for this bot
    const botDeals = await callTool('list_deals', { dealType: 'dca', botId, fields: 'minimal' })
    assert(!isErrorResponse(botDeals), 'list_deals filtered by botId → success')
  } else {
    console.log('    (no DCA bots found, skipping detail tests)')
  }

  // 8. Multiple boolean gate violations
  console.log('\n── Advanced Validation ──')
  const multiGate = await callTool('update_bot', {
    botType: 'dca',
    botId: 'test123',
    settings: {
      ordersCount: 5,
      tpPerc: '2',
      slPerc: '-5',
      moveSLTrigger: '1',
    }
  })
  assert(isErrorResponse(multiGate), 'Multiple boolean gate violations → error')
  const multiGateText = getContent(multiGate)
  assert(multiGateText.includes('useDca'), 'Multi-gate error mentions useDca')
  assert(multiGateText.includes('useTp'), 'Multi-gate error mentions useTp')
  assert(multiGateText.includes('useSl'), 'Multi-gate error mentions useSl')
  assert(multiGateText.includes('moveSL'), 'Multi-gate error mentions moveSL')

  // Valid boolean gates should pass validation (will fail at API since fake botId, but not validation)
  const validGates = await callTool('update_bot', {
    botType: 'dca',
    botId: 'test123',
    settings: { useDca: true, ordersCount: 5, orderSize: '200' },
  })
  // This should NOT be a validation error (but might be API error for fake botId)
  const validGatesText = getContent(validGates)
  assert(!validGatesText.includes('Boolean gate'), 'Valid boolean gates pass validation')

  // update_deal boolean gate
  const dealGate = await callTool('update_deal', {
    dealType: 'dca',
    dealId: 'test123',
    settings: { trailingTpPerc: '0.5' },  // missing trailingTp: true AND useTp: true
  })
  assert(isErrorResponse(dealGate), 'update_deal boolean gate violation → error')
  assert(getContent(dealGate).includes('useTp'), 'Deal gate error mentions useTp')

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════')
  console.log(`✅ Passed: ${passed.length}`)
  console.log(`❌ Failed: ${failed.length}`)
  if (failed.length > 0) {
    console.log('\nFailed tests:')
    for (const f of failed) console.log(`  - ${f}`)
  }
  console.log('══════════════════════════════════════════\n')
}

// ── Run ──────────────────────────────────────────────────────────────────────

try {
  await runTests()
} catch (err) {
  console.error('Fatal test error:', err)
  if (stderrBuf) console.error('Server stderr:', stderrBuf)
} finally {
  proc.kill('SIGTERM')
  process.exit(failed.length > 0 ? 1 : 0)
}
