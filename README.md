# gainium-mcp

An MCP (Model Context Protocol) server for [Gainium](https://gainium.io) — the crypto trading bot platform. Lets AI assistants manage your bots, deals, balances, and more through a standard MCP interface.

Detailed setup and connection documentation is available in [docs/using-gainium-mcp.md](docs/using-gainium-mcp.md).

## Quick Start

### 1. Get your API keys

Go to [Gainium API Settings](https://app.gainium.io/app/api) and create an API key pair.

### 2. Add to your MCP client

Add this to your MCP configuration (VS Code, Claude Desktop, etc.):

```json
{
  "gainium-mcp": {
    "command": "npx",
    "args": ["-y", "gainium-mcp"],
    "env": {
      "GAINIUM_API_KEY": "<your-api-key>",
      "GAINIUM_API_SECRET": "<your-api-secret>"
    }
  }
}
```

That's it. The server starts automatically when your AI assistant needs it.

This local stdio mode uses `GAINIUM_API_KEY` and `GAINIUM_API_SECRET` from the server process environment.

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GAINIUM_API_KEY` | Yes | — | Your Gainium API public key |
| `GAINIUM_API_SECRET` | Yes | — | Your Gainium API secret |
| `GAINIUM_API_BASE_URL` | No | `https://api.gainium.io` | API base URL |
| `GAINIUM_MCP_TRANSPORT` | No | `stdio` | Transport mode: `stdio`, `http`, `streamable-http`, `sse`, or `http-sse` |
| `GAINIUM_MCP_HOST` | No | `127.0.0.1` | Bind host for HTTP mode |
| `GAINIUM_MCP_PORT` | No | `3000` | Bind port for HTTP mode |
| `GAINIUM_MCP_HTTP_PATH` | No | `/mcp` | Streamable HTTP endpoint path |
| `GAINIUM_MCP_SSE_PATH` | No | `/sse` | Deprecated SSE GET endpoint path |
| `GAINIUM_MCP_MESSAGES_PATH` | No | `/messages` | Deprecated SSE POST endpoint path |
| `GAINIUM_OAUTH_ISSUER` | No | — | Authorization-server base URL. Setting this (with `MCP_INTROSPECTION_SECRET`, in HTTP mode) enables OAuth protected-resource mode |
| `GAINIUM_INTROSPECTION_URL` | No | `<issuer>/oauth/introspect` | Token introspection endpoint |
| `MCP_INTROSPECTION_SECRET` | No | — | Shared secret presented to the introspection endpoint (must match the auth server) |
| `GAINIUM_MCP_PUBLIC_URL` | No | derived from request | Public base URL used in the protected-resource metadata |
| `OPENAI_APPS_CHALLENGE_TOKEN` | No | — | When set, served as plain text at `/.well-known/openai-apps-challenge` for OpenAI Apps domain verification |

## Authentication Modes

`gainium-mcp` supports three deployment models:

- **Local stdio mode:** the MCP server reads `GAINIUM_API_KEY` and `GAINIUM_API_SECRET` from env vars.
- **OAuth 2.1 hosted mode (recommended for hosted/public):** the server acts as an OAuth protected resource. Clients (e.g. the Claude connector) obtain an access token from the Gainium authorization server and send it as `Authorization: Bearer <token>`. See [OAuth 2.1 hosted mode](#oauth-21-hosted-mode) below.
- **Header hosted mode (legacy/self-hosted):** each request sends `X-API-Key` and `X-API-Secret` headers so one shared server can serve many users.

In header/stdio mode, request headers take priority, falling back to `GAINIUM_API_KEY` / `GAINIUM_API_SECRET`. When OAuth mode is enabled, the Bearer token is required and the `X-API-Key`/`X-API-Secret` headers are ignored.

### OAuth 2.1 hosted mode

This is the mode used for the public `https://mcp.gainium.io/mcp` endpoint and the Anthropic Claude connector directory (which requires OAuth and forbids API-key headers).

Enable it by setting, in HTTP mode:

```bash
export GAINIUM_MCP_TRANSPORT=http
export GAINIUM_OAUTH_ISSUER=https://app.gainium.io        # Gainium authorization server
export MCP_INTROSPECTION_SECRET=<shared-secret>           # must match the auth server
export GAINIUM_MCP_PUBLIC_URL=https://mcp.gainium.io      # this server's public URL
# optional, defaults to <issuer>/oauth/introspect:
# export GAINIUM_INTROSPECTION_URL=https://app.gainium.io/oauth/introspect
node dist/server.js
```

When enabled, the server:

1. Serves **OAuth Protected Resource Metadata** (RFC 9728) at
   `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`,
   advertising the authorization server.
2. Rejects unauthenticated MCP requests with **`401 Unauthorized`** and a
   `WWW-Authenticate: Bearer resource_metadata="…"` header, so clients can discover
   the auth server and run the OAuth flow (Dynamic Client Registration + PKCE).
3. Validates the Bearer access token on each request via the auth server's
   **token introspection** endpoint, resolving it to the user's Gainium
   `(apiKey, apiSecret)` and per-key restrictions (read/write, paper-only, single-bot),
   which are still enforced server-side. Introspection results are cached briefly.

The local stdio path is unaffected by these variables.

## HTTP and SSE Mode

By default, `gainium-mcp` runs over stdio for MCP clients that spawn local processes. To run it as an HTTP server instead:

```bash
export GAINIUM_MCP_TRANSPORT=http
export GAINIUM_MCP_HOST=127.0.0.1
export GAINIUM_MCP_PORT=3000
node dist/server.js
```

When HTTP mode is enabled, the server exposes both transport styles:

- `GET|POST|DELETE /mcp` for the current Streamable HTTP transport
- `GET /sse` plus `POST /messages?sessionId=...` for deprecated HTTP+SSE clients

This makes one server process compatible with both modern MCP HTTP clients and older SSE-based integrations. In hosted mode, authenticate with OAuth (see [OAuth 2.1 hosted mode](#oauth-21-hosted-mode)) or, for self-hosted/legacy setups, send `X-API-Key` and `X-API-Secret` on each request.

## Available Tools (17)

As of v3.0.0 the toolset is consolidated: a single tool per operation, with a
`botType` / `dealType` / `action` discriminator instead of one tool per variant.
Every tool carries an MCP safety annotation — read-only tools set `readOnlyHint`,
write tools set `destructiveHint`.

### Bots

| Tool | Access | Description |
|---|---|---|
| `list_bots` | read | List bots by type (`dca`, `combo`, `grid`) with filters and field selection |
| `get_bot` | read | Get a single bot by id and type |
| `create_bot` | write | Create a bot (`dca`, `combo`, or `grid`) |
| `update_bot` | write | Update bot settings |
| `clone_bot` | write | Clone a bot with optional overrides |
| `manage_bot` | write | Lifecycle action: `start`, `stop`, `archive`, `restore`, `changePairs` |

### Deals

| Tool | Access | Description |
|---|---|---|
| `list_deals` | read | List deals by type (`dca`, `combo`, `terminal`) with filters |
| `get_deal` | read | Get a single deal by id and type |
| `create_deal` | write | Create a deal |
| `update_deal` | write | Update an active deal |
| `manage_deal` | write | Deal action: `close`, `addFunds`, `reduceFunds` |

### Backtest

| Tool | Access | Description |
|---|---|---|
| `run_backtest` | write | Run a backtest: `validate`, `estimate`, async, or sync (`request`/`requestSync` submit a job — not read-only) |
| `backtest_info` | read | List backtest requests or get one by ID |

### Discovery, Account & Market

| Tool | Access | Description |
|---|---|---|
| `discover` | read | Schema discovery for bot types and indicators |
| `get_account` | read | Balances, connected exchanges, supported exchanges, and global variables |
| `get_screener` | read | Cryptocurrency screener with market metrics |
| `manage_global_variable` | write | Global variable action: `create`, `update`, `delete` |

## Field Selection

All GET endpoints support the `fields` parameter for efficient payloads:

- **Presets**: `minimal`, `standard` (default), `extended`, `full`
- **Custom**: comma-separated dot-notation fields (e.g. `_id,uuid,settings.name,profit.total`)

Using `minimal` reduces payload size by ~85%.

## API Permissions

- **Read-only key**: read tools only (`list_*`, `get_*`, `discover`, `backtest_info`, `get_screener`, `list_presets`)
- **Write key**: all tools, including `create_*`, `update_*`, `clone_bot`, `manage_bot`, `manage_deal`, `manage_global_variable`, `apply_preset`, and `run_backtest`
- **Read-only directory connector** (`/mcp` with `GAINIUM_READONLY=true`, served at `mcp.gainium.io/read`): exposes and allows only the 9 `readOnlyHint` tools — `run_backtest` and all write tools are excluded

## Development

```bash
# Clone and install
git clone https://github.com/gainium/gainium-mcp.git
cd gainium-mcp
npm install

# Build
npm run build

# Run locally (for testing)
export GAINIUM_API_KEY=your_key
export GAINIUM_API_SECRET=your_secret
node dist/server.js

# Run in HTTP/SSE mode
export GAINIUM_MCP_TRANSPORT=http
export GAINIUM_MCP_PORT=3000
node dist/server.js
```

## Architecture

```
gainium-mcp/
├── src/
│   ├── server.ts          # MCP server + tool definitions (stdio + HTTP/SSE transports)
│   └── gainium-client.ts  # HMAC-authenticated HTTP client for Gainium API v2
├── dist/                  # Compiled output (published to npm)
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT
