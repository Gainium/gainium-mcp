# gainium-mcp

An MCP (Model Context Protocol) server for [Gainium](https://gainium.io) — the crypto trading bot platform. Lets AI assistants manage your bots, deals, balances, and more through a standard MCP interface.

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

## Authentication Modes

`gainium-mcp` supports both deployment models:

- Local stdio mode: the MCP server reads `GAINIUM_API_KEY` and `GAINIUM_API_SECRET` from env vars.
- Hosted HTTP mode: each request can send `X-API-Key` and `X-API-Secret` headers so one shared server can serve many users.

For HTTP mode, request headers take priority. If the headers are missing, the server falls back to `GAINIUM_API_KEY` and `GAINIUM_API_SECRET` if they are set.

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

This makes one server process compatible with both modern MCP HTTP clients and older SSE-based integrations. In hosted mode, callers should send their Gainium credentials on each request as `X-API-Key` and `X-API-Secret`.

## Available Tools (48)

### Bots — Read

| Tool | Description |
|---|---|
| `get_dca_bots` | List DCA bots with field selection and filters |
| `get_combo_bots` | List Combo bots with field selection and filters |
| `get_grid_bots` | List Grid bots with field selection and filters |

### Bots — Create

| Tool | Description |
|---|---|
| `create_dca_bot` | Create a new DCA bot |
| `create_combo_bot` | Create a new Combo bot |
| `create_grid_bot` | Create a new Grid bot |

### Bots — Update & Clone

| Tool | Description |
|---|---|
| `update_dca_bot` | Update DCA bot settings |
| `update_combo_bot` | Update Combo bot settings |
| `clone_dca_bot` | Clone a DCA bot with optional overrides |
| `clone_combo_bot` | Clone a Combo bot with optional overrides |
| `clone_grid_bot` | Clone a Grid bot with optional overrides |

### Bots — Lifecycle

| Tool | Description |
|---|---|
| `start_bot` | Start a bot (dca, combo, or grid) |
| `stop_bot` | Stop a running bot |
| `archive_bot` | Archive a stopped bot (soft delete) |
| `restore_bot` | Restore an archived bot |
| `change_bot_pairs` | Change trading pairs for a DCA bot |

### Deals — Read

| Tool | Description |
|---|---|
| `get_dca_deals` | List DCA deals with filters and field selection |
| `get_combo_deals` | List Combo deals with filters and field selection |
| `get_terminal_deals` | List Terminal deals with filters and field selection |

### Deals — Create & Manage

| Tool | Description |
|---|---|
| `create_terminal_deal` | Create a one-time terminal deal |
| `update_dca_deal` | Update active DCA deal settings |
| `update_combo_deal` | Update active Combo deal settings |
| `update_terminal_deal` | Update active Terminal deal settings |
| `start_deal` | Start a new deal for a bot |
| `close_deal` | Close an active deal (dca, combo, or terminal) |
| `add_funds` | Add funds to a DCA deal |
| `reduce_funds` | Reduce funds from a DCA deal |
| `add_funds_terminal` | Add funds to a Terminal deal |
| `reduce_funds_terminal` | Reduce funds from a Terminal deal |

### Backtest

| Tool | Description |
|---|---|
| `estimate_backtest_cost` | Estimate backtest cost in credits |
| `request_backtest` | Submit async backtest request |
| `request_backtest_sync` | Submit backtest and wait for result (up to 1h) |
| `get_backtest_requests` | List backtest requests for a bot type |
| `get_backtest_request` | Get a single backtest request by ID |
| `validate_backtest_payload` | Validate bot settings and return normalized backtest payload |

### Discovery

| Tool | Description |
|---|---|
| `get_discovery_bots` | List schema definitions for all bot types |
| `get_discovery_bot` | Get the full schema definition for one bot type |
| `get_discovery_bot_sections` | List section summaries for one bot type |
| `get_discovery_indicators` | List supported indicator types and capabilities |
| `get_discovery_indicator` | Get the full field definition for one indicator type |

### User & Account

| Tool | Description |
|---|---|
| `get_balances` | Get balances across exchanges |
| `get_user_exchanges` | List connected exchange accounts |
| `get_global_variables` | List global variables |
| `create_global_variable` | Create a global variable |
| `update_global_variable` | Update a global variable |
| `delete_global_variable` | Delete a global variable |

### General

| Tool | Description |
|---|---|
| `get_supported_exchanges` | List supported exchanges |
| `get_screener` | Crypto screener with market metrics |

## Field Selection

All GET endpoints support the `fields` parameter for efficient payloads:

- **Presets**: `minimal`, `standard` (default), `extended`, `full`
- **Custom**: comma-separated dot-notation fields (e.g. `_id,uuid,settings.name,profit.total`)

Using `minimal` reduces payload size by ~85%.

## API Permissions

- **Read-only key**: Use `get_*` tools (bots, deals, balances, screener)
- **Write key**: All tools including create, update, start, stop, archive

## Development

```bash
# Clone and install
git clone https://github.com/nicogainium/gainium-mcp.git
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
