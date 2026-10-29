import { describe, it, expect } from 'vitest'
import {
  isHostAllowed,
  isOriginAllowed,
  parseAllowedHosts,
} from '../server.js'

describe('isHostAllowed', () => {
  it('accepts loopback and IP-literal hosts on any port', () => {
    for (const host of [
      'localhost:3000',
      'LOCALHOST:8080',
      '127.0.0.1:3000',
      '[::1]:3000',
      '10.0.0.5:3000',
      '203.0.113.7',
    ]) {
      expect(isHostAllowed(host, [])).toBe(true)
    }
  })

  it('rejects DNS names that are not allowlisted', () => {
    expect(isHostAllowed('attacker.example:3000', [])).toBe(false)
    expect(isHostAllowed('localhost.attacker.example:3000', [])).toBe(false)
    expect(isHostAllowed(undefined, [])).toBe(false)
    expect(isHostAllowed('evil@127.0.0.1:3000', [])).toBe(false)
  })

  it('honours allowlist entries with or without a port', () => {
    expect(isHostAllowed('mcp.example.com', ['mcp.example.com'])).toBe(true)
    expect(isHostAllowed('mcp.example.com:3000', ['mcp.example.com'])).toBe(true)
    expect(
      isHostAllowed('mcp.example.com:3000', ['mcp.example.com:3000']),
    ).toBe(true)
    expect(
      isHostAllowed('mcp.example.com:4000', ['mcp.example.com:3000']),
    ).toBe(false)
  })
})

describe('isOriginAllowed', () => {
  it('allows requests without an Origin (non-browser clients)', () => {
    expect(isOriginAllowed(undefined, '127.0.0.1:3000', [])).toBe(true)
  })

  it('allows same-origin and loopback origins', () => {
    expect(
      isOriginAllowed('http://127.0.0.1:3000', '127.0.0.1:3000', []),
    ).toBe(true)
    expect(isOriginAllowed('http://localhost:5173', '127.0.0.1:3000', [])).toBe(
      true,
    )
  })

  it('rejects foreign and opaque origins', () => {
    expect(
      isOriginAllowed('https://attacker.example', '127.0.0.1:3000', []),
    ).toBe(false)
    expect(isOriginAllowed('http://203.0.113.9', '127.0.0.1:3000', [])).toBe(
      false,
    )
    expect(isOriginAllowed('null', '127.0.0.1:3000', [])).toBe(false)
  })

  it('allows allowlisted origins', () => {
    expect(
      isOriginAllowed('https://app.example.com', '127.0.0.1:3000', [
        'app.example.com',
      ]),
    ).toBe(true)
  })
})

describe('parseAllowedHosts', () => {
  it('normalises a comma list, stripping schemes and paths', () => {
    expect(
      parseAllowedHosts(' MCP.example.com , https://other.example:8443/mcp ,'),
    ).toEqual(['mcp.example.com', 'other.example:8443'])
    expect(parseAllowedHosts(undefined)).toEqual([])
  })
})
