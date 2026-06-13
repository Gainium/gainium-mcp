# Anthropic Connector Directory — Submission Package & Checklist

Tracking doc for listing Gainium MCP in the Claude connector directory.

## Status of hard requirements

| Requirement | Status | Notes |
|---|---|---|
| Production HTTPS hosting | ✅ Done | `https://mcp.gainium.io/mcp` |
| Streamable HTTP transport | ✅ Done | `/mcp` endpoint already serves it |
| Tool safety annotations (`title` + `readOnlyHint`/`destructiveHint`) | ✅ Done | All 19 tools annotated in `src/server.ts` |
| Narrow, non-promotional tool descriptions | ✅ Done | Reviewed; factual |
| Read/write split (no read+write behind one method param) | ✅ Pass | `manage_*` tools are write-only; reads are separate tools |
| **OAuth 2.0** for user data access | ✅ Done | Protected-resource mode in `src/server.ts` (v3.1.0): `/.well-known/oauth-protected-resource` (RFC 9728), `401 + WWW-Authenticate`, Bearer→introspection against the Gainium auth server. Enable via `GAINIUM_OAUTH_ISSUER` + `MCP_INTROSPECTION_SECRET`. |
| Public docs with ≥3 example prompts | ✅ Done | `gainium.io/help/mcp` → "Example prompts to try" (3 prompts) |
| Privacy policy URL | ✅ Done | https://gainium.io/legal/privacy-policy |
| Working test credentials + populated account | ⚠️ Partial | Paper account provisioned (see below); still needs sample bots/deals so reviewers can exercise read/backtest tools |
| Logo / branding assets | ✅ Done | `assets/gainium-logo-512.png` + `gainium-logo-1024.png` (V2 icon) |
| Support contact | ✅ Done | hello@gainium.io |

**OAuth is built and live in production** (`api.gainium.io` auth server + `mcp.gainium.io` resource server, reverse-proxy `/.well-known/` routing in place). Remaining items are content/config (example-prompt docs, support contact, populated test account).

## Reviewer test account

Paper-only account for Anthropic reviewers (no real funds; trading actions are paper-mode):

- **URL:** https://app.gainium.io
- **User:** `demo@gainium.io`
- **Password:** `egGEg45o@#`

On first connect, Claude runs the OAuth flow → consent on `app.gainium.io` → reviewers grant read (and optionally write) scope. Recommend leaving the connection **read + paper-only** so reviewers can exercise every tool safely.

## Submission form fields (draft)

- **Name:** Gainium
- **Server URL:** `https://mcp.gainium.io/mcp`
- **Transport:** Streamable HTTP
- **Auth:** OAuth 2.1 (PKCE + Dynamic Client Registration) — callback `https://claude.ai/api/mcp/auth_callback`; authorization server `https://api.gainium.io`
- **Privacy policy:** https://gainium.io/legal/privacy-policy
- **Logo:** `assets/gainium-logo-1024.png` (Gainium V2 app icon)
- **Tagline:** Manage your crypto trading bots, deals, and backtests from Claude.
- **Description:** Gainium MCP lets Claude read and manage your Gainium account — DCA, Combo, and Grid bots; deals; balances; backtests; the crypto screener; and curated strategy presets — through standard MCP tools. Write actions respect server-side API-key restrictions (paper-only, single-bot) for safety.
- **Support contact:** hello@gainium.io
- **Use cases:**
  1. "Summarize my open bots and deals with pair, status, take-profit %, and unrealized P&L, and flag any deal without a stop-loss."
  2. "Find the 3 most volatile coins on the screener and create a paper DCA bot trading them with a 2% take-profit."
  3. "Show Gainium's top curated DCA presets for BTC on Binance and create a paper bot from the mid-risk long strategy."

## Tool listing (19)

**Read-only:** `list_bots`, `get_bot`, `list_deals`, `get_deal`, `run_backtest`, `backtest_info`, `discover`, `get_account`, `get_screener`, `list_presets`

**Write / destructive:** `create_bot`, `update_bot`, `clone_bot`, `manage_bot` (start/stop/archive/restore/changePairs), `create_deal`, `update_deal`, `manage_deal` (close/addFunds/reduceFunds), `manage_global_variable` (create/update/delete), `apply_preset`

## Example prompts (live in public docs)

Published at `gainium.io/help/mcp` → "Example prompts to try". Expected tool flows:

1. **"Summarize my open bots and deals with pair, status, take-profit %, and unrealized P&L; flag any deal without a stop-loss."** → `list_bots` + `list_deals` (+ `get_deal` for detail); read-only.
2. **"Find the 3 most volatile coins on the screener and create a paper DCA bot trading them with a 2% take-profit and a 3-order ladder."** → `get_screener` (sort=volatility) → `create_bot` (botType=dca, paperContext=true).
3. **"Show Gainium's top curated DCA presets for BTC on Binance, compare risk tiers, and create a paper bot from the mid-risk long strategy."** → `list_presets` → `apply_preset` (tier=mid, strategy=long, paperContext=true).

## Pre-submission testing
1. Test as a custom connector: Claude Settings → Connectors → Add custom connector → paste `https://mcp.gainium.io/mcp`.
2. Validate with MCP Inspector (protocol, OAuth flow, schemas).
3. Confirm every tool returns realistic data against the test account.

## Submit

This is a **remote** MCP server (`https://mcp.gainium.io/mcp`), so it goes through the remote-server path:

- **Primary (recommended): the submission portal inside Claude.ai.** Sign in as an Owner/Primary owner of a **Team or Enterprise** org → admin settings → Connectors directory submission portal. Requires Directory management access. Track status + reviewer feedback in the submissions dashboard there.
- **Fallback (if you don't have a Team/Enterprise org or portal access): the public MCP directory submission form** linked from the submission guide below.

Docs:
- Submission overview: https://claude.com/docs/connectors/building/submission
- Remote MCP server submission guide: https://support.claude.com/en/articles/12922490-remote-mcp-server-submission-guide
- Connectors directory FAQ: https://support.claude.com/en/articles/11596036-anthropic-connectors-directory-faq

Before submitting: provide the reviewer test credentials (above), ensure the privacy policy is reachable, and run every tool yourself against the test account (ideally populate it with a few sample bots/deals first).
