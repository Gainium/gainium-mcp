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

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GAINIUM_API_KEY` | Yes | — | Your Gainium API public key |
| `GAINIUM_API_SECRET` | Yes | — | Your Gainium API secret |
| `GAINIUM_API_BASE_URL` | No | `https://api.gainium.io` | API base URL |

## Available Tools (31)

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

### Bots — Lifecycle

| Tool | Description |
|---|---|
| `start_bot` | Start a bot |
| `stop_bot` | Stop a running bot |
| `archive_bot` | Archive a stopped bot |
| `restore_bot` | Restore an archived bot |
| `change_bot_pairs` | Change trading pairs for a bot |

### Deals

| Tool | Description |
|---|---|
| `get_deals` | List deals with filters (type, status, botId) |
| `create_terminal_deal` | Create a one-time terminal deal |
| `update_dca_deal` | Update active DCA deal settings |
| `update_combo_deal` | Update active Combo deal settings |
| `start_deal` | Start a new deal for a bot |
| `close_deal` | Close an active deal |
| `add_funds` | Add funds to a deal |
| `reduce_funds` | Reduce funds from a deal |

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
```

## Architecture

```
gainium-mcp/
├── src/
│   ├── server.ts          # MCP server + tool definitions (stdio transport)
│   └── gainium-client.ts  # HMAC-authenticated HTTP client for Gainium API v2
├── dist/                  # Compiled output (published to npm)
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT
