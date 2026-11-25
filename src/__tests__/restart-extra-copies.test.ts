import { describe, it, expect } from 'vitest'
// @ts-ignore -- plain ESM deploy script, no type declarations
import { selectExtraCopies, parseJlist, restartExtraCopies } from '../../scripts/restart-extra-copies.mjs'

const CWD = '/opt/gainium/gainium-mcp'
const fixture = [
  { pm_id: 8, name: 'Gainium MCP server', pm2_env: { pm_cwd: CWD } },
  { pm_id: 36, name: 'gainium-mcp-read', pm2_env: { pm_cwd: CWD } },
  { pm_id: 3, name: 'other-service', pm2_env: { pm_cwd: '/opt/gainium/other' } },
]

describe('selectExtraCopies (spec 002 §1.1, §1.5)', () => {
  it('selects only the same-cwd process that ecosystem.config.cjs does not name', () => {
    expect(selectExtraCopies(fixture, CWD, ['Gainium MCP server'])).toEqual([36])
  })

  it('matches cwd regardless of a trailing slash', () => {
    const j = [{ pm_id: 36, name: 'x', pm2_env: { pm_cwd: CWD + '/' } }]
    expect(selectExtraCopies(j, CWD, [])).toEqual([36])
  })

  it('returns nothing when there are no extra copies (§1.3)', () => {
    expect(selectExtraCopies(fixture.slice(0, 1).concat(fixture[2]), CWD, ['Gainium MCP server'])).toEqual([])
    expect(selectExtraCopies([], CWD, ['Gainium MCP server'])).toEqual([])
  })
})

describe('parseJlist', () => {
  it('tolerates a non-JSON banner before the array', () => {
    expect(parseJlist('>>>> In-memory PM2 is out-of-date\n' + JSON.stringify(fixture))).toHaveLength(3)
    expect(parseJlist('[]')).toEqual([])
  })
})

describe('restartExtraCopies (§1.2, §1.4)', () => {
  it('restarts each extra copy by id with no --update-env', () => {
    const calls: string[][] = []
    const code = restartExtraCopies({
      jlist: () => JSON.stringify(fixture),
      run: (args: string[]) => { calls.push(args) },
      cwd: CWD,
      names: ['Gainium MCP server'],
      log: () => {},
    })
    expect(code).toBe(0)
    expect(calls).toEqual([['restart', '36']])
  })

  it('does nothing and exits 0 when there are no extra copies', () => {
    const calls: string[][] = []
    const code = restartExtraCopies({
      jlist: () => JSON.stringify([fixture[0]]),
      run: (args: string[]) => { calls.push(args) },
      cwd: CWD,
      names: ['Gainium MCP server'],
      log: () => {},
    })
    expect(code).toBe(0)
    expect(calls).toEqual([])
  })

  it('attempts every copy and exits non-zero if any restart fails', () => {
    const j = [...fixture, { pm_id: 40, name: 'third', pm2_env: { pm_cwd: CWD } }]
    const calls: string[][] = []
    const code = restartExtraCopies({
      jlist: () => JSON.stringify(j),
      run: (args: string[]) => { calls.push(args); if (args[1] === '36') throw new Error('boom') },
      cwd: CWD,
      names: ['Gainium MCP server'],
      log: () => {},
    })
    expect(code).toBe(1)
    expect(calls).toEqual([['restart', '36'], ['restart', '40']])
  })
})
