# Anthropic Connector Directory — Submission Package & Checklist

Tracking doc for listing Gainium MCP in the Claude connector directory.

## Status of hard requirements

| Requirement | Status | Notes |
|---|---|---|
| Production HTTPS hosting | ✅ Done | `https://mcp.gainium.io/mcp` |
| Streamable HTTP transport | ✅ Done | `/mcp` endpoint already serves it |
| Tool safety annotations (`title` + `readOnlyHint`/`destructiveHint`) | ✅ Done | All 17 tools annotated in `src/server.ts` |
| Narrow, non-promotional tool descriptions | ✅ Done | Reviewed; factual |
| Read/write split (no read+write behind one method param) | ✅ Pass | `manage_*` tools are write-only; reads are separate tools |
| **OAuth 2.0** for user data access | ✅ Done | Protected-resource mode in `src/server.ts` (v3.1.0): `/.well-known/oauth-protected-resource` (RFC 9728), `401 + WWW-Authenticate`, Bearer→introspection against the Gainium auth server. Enable via `GAINIUM_OAUTH_ISSUER` + `MCP_INTROSPECTION_SECRET`. |
| Public docs with ≥3 example prompts | ⚠️ Partial | `gainium.io/help/mcp` exists; add example-prompts section |
| Privacy policy URL | ✅ Done | https://gainium.io/legal/privacy-policy |
| Working test credentials + populated account | ⚠️ TODO | Provision a paper-mode account with sample bots/deals |
| Logo / branding assets | ✅ Done | `assets/gainium-logo-512.png` + `gainium-logo-1024.png` (V2 icon) |
| Support contact | ⚠️ Confirm | e.g. support@gainium.io |

**The OAuth layer is the only true engineering blocker. Everything else is content/config.**

## Submission form fields (draft)

- **Name:** Gainium
- **Server URL:** `https://mcp.gainium.io/mcp`
- **Transport:** Streamable HTTP
- **Auth:** OAuth 2.0 (once built) — callback `https://claude.ai/api/mcp/auth_callback`
- **Privacy policy:** https://gainium.io/legal/privacy-policy
- **Logo:** `assets/gainium-logo-1024.png` (Gainium V2 app icon)
- **Tagline:** Manage your crypto trading bots, deals, and backtests from Claude.
- **Description:** Gainium MCP lets Claude read and manage your Gainium account — DCA, Combo, and Grid bots; deals; balances; backtests; and the crypto screener — through standard MCP tools. Write actions respect server-side API-key restrictions (paper-only, single-bot) for safety.
- **Use cases:**
  1. "Show me my running DCA bots and their open deals."
  2. "Back-test this DCA config on BTC_USDT over the last 90 days before I deploy it."
  3. "Stop bot X and close its deals by market." (paper mode)

## Tool listing (17)

**Read-only:** `list_bots`, `get_bot`, `list_deals`, `get_deal`, `run_backtest`, `backtest_info`, `discover`, `get_account`, `get_screener`

**Write / destructive:** `create_bot`, `update_bot`, `clone_bot`, `manage_bot` (start/stop/archive/restore/changePairs), `create_deal`, `update_deal`, `manage_deal` (close/addFunds/reduceFunds), `manage_global_variable` (create/update/delete)

## Example prompts to add to public docs (≥3 required, with expected outcomes)

1. **"List my active DCA bots."** → calls `list_bots` (botType=dca), returns bot names, status, pairs, PnL.
2. **"Back-test a DCA bot on ETH_USDT for the last 60 days and estimate the cost first."** → `run_backtest` (mode=estimate then async), returns cost estimate then results summary.
3. **"In paper mode, stop my bot 507f… and close positions by market."** → `manage_bot` (action=stop, paperContext=true, closeType=closeByMarket), returns confirmation.

## Pre-submission testing
1. Test as a custom connector: Claude Settings → Connectors → Add custom connector → paste `https://mcp.gainium.io/mcp`.
2. Validate with MCP Inspector (protocol, OAuth flow, schemas).
3. Confirm every tool returns realistic data against the test account.

## Submit
Via the MCP directory form in Anthropic's developer docs (servers/apps form). Provide test credentials + sample data so reviewers can exercise every tool.
