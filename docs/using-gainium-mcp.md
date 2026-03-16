# Using gainium-mcp

This guide explains how to run and connect to `gainium-mcp` in the main deployment modes:

- Local `stdio`
- Local HTTP
- Local SSE
- Hosted remote HTTP

It also explains authentication, paper trading, bot restrictions, and how common MCP clients can connect to the server.

## What This Server Does

`gainium-mcp` is an MCP server for Gainium. It exposes Gainium API operations as MCP tools so MCP-compatible clients can:

- Read bots, deals, balances, exchanges, screeners, and backtests
- Create and update bots and deals
- Start, stop, archive, restore, and clone bots
- Run backtest validation and submission flows
- Discover bot and indicator schemas

The server supports two authentication models:

- Local process auth via `GAINIUM_API_KEY` and `GAINIUM_API_SECRET`
- Hosted HTTP auth via per-request headers `X-API-Key` and `X-API-Secret`

## Transport Modes

`gainium-mcp` supports these MCP transport styles:

- `stdio`: the MCP client launches the server as a local process
- Streamable HTTP: the client connects to an HTTP endpoint such as `/mcp`
- SSE: the legacy HTTP+SSE mode using `/sse` and `/messages`

In this repo, `stdio` is the default. HTTP mode is enabled by setting `GAINIUM_MCP_TRANSPORT=http`.

## Environment Variables

These are the main runtime settings:

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GAINIUM_API_KEY` | Local only | none | Gainium public API key |
| `GAINIUM_API_SECRET` | Local only | none | Gainium API secret |
| `GAINIUM_API_BASE_URL` | No | `https://api.gainium.io` | Gainium REST API base URL |
| `GAINIUM_MCP_TRANSPORT` | No | `stdio` | `stdio` or `http` |
| `GAINIUM_MCP_HOST` | No | `127.0.0.1` | Bind host for HTTP mode |
| `GAINIUM_MCP_PORT` | No | `3000` | Bind port for HTTP mode |
| `GAINIUM_MCP_HTTP_PATH` | No | `/mcp` | Streamable HTTP path |
| `GAINIUM_MCP_SSE_PATH` | No | `/sse` | Legacy SSE GET path |
| `GAINIUM_MCP_MESSAGES_PATH` | No | `/messages` | Legacy SSE POST path |
| `GAINIUM_ALLOWED_BOT_ID` | No | none | Restrict tool usage to one bot |
| `GAINIUM_PAPER_ONLY` | No | `false` | Force paper-only mode |

## Important Behavior

Two settings are often misunderstood:

### `GAINIUM_ALLOWED_BOT_ID`

This is a server-side restriction. If set, the server will either:

- Force list-style requests to that bot ID
- Reject operations targeting a different bot ID

This is not a client-side config value. You cannot set it in a remote MCP connection block unless you run your own server instance and define the environment variable there.

### `GAINIUM_PAPER_ONLY`

This is also server-side. If set to `true`:

- Requests that explicitly set `paperContext: false` will be rejected
- Requests that omit `paperContext` will be treated as paper trading

If the server is not running with `GAINIUM_PAPER_ONLY=true`, then paper mode is controlled per tool call using `paperContext: true`.

## Running Modes

## 1. Local stdio

This is the simplest setup. Your MCP client starts `gainium-mcp` as a local child process.

Use this when:

- Your client supports `stdio`
- You want the simplest setup
- You do not want to expose an HTTP endpoint
- You want to manage credentials locally via environment variables

Example:

```json
{
  "mcpServers": {
    "gainium": {
      "command": "npx",
      "args": ["-y", "gainium-mcp"],
      "env": {
        "GAINIUM_API_KEY": "YOUR_GAINIUM_API_KEY",
        "GAINIUM_API_SECRET": "YOUR_GAINIUM_API_SECRET"
      }
    }
  }
}
```

### Local stdio with bot restriction and forced paper mode

```json
{
  "mcpServers": {
    "gainium": {
      "command": "npx",
      "args": ["-y", "gainium-mcp"],
      "env": {
        "GAINIUM_API_KEY": "YOUR_GAINIUM_API_KEY",
        "GAINIUM_API_SECRET": "YOUR_GAINIUM_API_SECRET",
        "GAINIUM_ALLOWED_BOT_ID": "507f1f77bcf86cd799439011",
        "GAINIUM_PAPER_ONLY": "true"
      }
    }
  }
}
```

In this model, the MCP client does not need to send `X-API-Key` or `X-API-Secret`. The server reads credentials from its own environment.

## 2. Local HTTP

In HTTP mode, you run the server yourself and point a compatible MCP client at it.

Use this when:

- Your client supports HTTP MCP connections
- You want to reuse one server across multiple tools or sessions
- You want to host the MCP endpoint behind a proxy or tunnel

Start the server:

```bash
export GAINIUM_API_KEY=YOUR_GAINIUM_API_KEY
export GAINIUM_API_SECRET=YOUR_GAINIUM_API_SECRET
export GAINIUM_MCP_TRANSPORT=http
export GAINIUM_MCP_HOST=127.0.0.1
export GAINIUM_MCP_PORT=3000
export GAINIUM_MCP_HTTP_PATH=/mcp
node dist/server.js
```

The modern endpoint is then:

```text
http://127.0.0.1:3000/mcp
```

Because this instance already has `GAINIUM_API_KEY` and `GAINIUM_API_SECRET` in its environment, the client usually does not need to send auth headers.

Example client config:

```json
{
  "mcpServers": {
    "gainium": {
      "transport": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

### Local HTTP with root path

If you want the HTTP endpoint on `/` instead of `/mcp`, set:

```bash
export GAINIUM_MCP_HTTP_PATH=/
```

This works, but it has tradeoffs:

- Existing `/mcp` clients will break
- You lose `/` for health pages, landing pages, or proxy routing later
- Debugging is usually clearer with a named path like `/mcp`

For public deployments, `/mcp` is the safer default.

## 3. Local SSE

When HTTP mode is enabled, the server also exposes the legacy SSE transport:

- `GET /sse`
- `POST /messages?sessionId=...`

Use this only if your MCP client does not support the newer Streamable HTTP transport.

Start the server the same way as local HTTP:

```bash
export GAINIUM_API_KEY=YOUR_GAINIUM_API_KEY
export GAINIUM_API_SECRET=YOUR_GAINIUM_API_SECRET
export GAINIUM_MCP_TRANSPORT=http
node dist/server.js
```

Default legacy endpoints:

```text
http://127.0.0.1:3000/sse
http://127.0.0.1:3000/messages
```

SSE is mainly here for backward compatibility. Prefer HTTP `/mcp` when your client supports it.

## 4. Hosted remote HTTP

This is the shared-server model. Instead of launching the MCP server locally, your MCP client connects to a hosted endpoint such as:

```text
http://mcp.gainium.io/mcp
```

Use this when:

- Your MCP client supports remote HTTP servers
- You do not want to run the server locally
- You are comfortable sending Gainium auth via MCP request headers to the hosted endpoint

Example:

```json
{
  "mcpServers": {
    "gainium": {
      "transport": "http",
      "url": "http://mcp.gainium.io/mcp",
      "headers": {
        "X-API-Key": "YOUR_GAINIUM_API_KEY",
        "X-API-Secret": "YOUR_GAINIUM_API_SECRET"
      }
    }
  }
}
```

### What you can and cannot configure in remote mode

You can configure:

- MCP server URL
- Request headers such as `X-API-Key` and `X-API-Secret`

You cannot configure, from the client alone:

- `GAINIUM_ALLOWED_BOT_ID`
- `GAINIUM_PAPER_ONLY`

Those are server environment settings. If you need them, run your own instance.

### Paper mode in remote mode

If the hosted server is not paper-locked, use `paperContext: true` in each relevant tool call.

Example:

```json
{
  "botId": "507f1f77bcf86cd799439011",
  "botType": "dca",
  "paperContext": true
}
```

## Choosing the Right Mode

Use local `stdio` when:

- Your client supports `stdio`
- You want the least moving parts
- You want secrets to stay entirely local

Use local HTTP when:

- Your client supports HTTP MCP but not `stdio`
- You want one reusable local server process
- You want to put the server behind a proxy or tunnel

Use hosted remote HTTP when:

- You do not want to run the server yourself
- Your client supports remote MCP over HTTP
- You can send custom headers for auth

Use SSE only when:

- Your client only supports the older SSE pattern

## Client Setup Examples

## VS Code

VS Code can connect either to a local process or a remote HTTP MCP server.

### VS Code with local stdio

```json
{
  "mcpServers": {
    "gainium": {
      "command": "npx",
      "args": ["-y", "gainium-mcp"],
      "env": {
        "GAINIUM_API_KEY": "YOUR_GAINIUM_API_KEY",
        "GAINIUM_API_SECRET": "YOUR_GAINIUM_API_SECRET"
      }
    }
  }
}
```

### VS Code with hosted remote HTTP

```json
{
  "mcpServers": {
    "gainium": {
      "transport": "http",
      "url": "http://mcp.gainium.io/mcp",
      "headers": {
        "X-API-Key": "YOUR_GAINIUM_API_KEY",
        "X-API-Secret": "YOUR_GAINIUM_API_SECRET"
      }
    }
  }
}
```

### VS Code with local HTTP

```json
{
  "mcpServers": {
    "gainium": {
      "transport": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

## Claude Code

Claude Code can connect to MCP servers over `stdio`, HTTP, and SSE. For remote servers, HTTP is the preferred option.

### Claude Code with hosted remote HTTP

Example CLI pattern:

```bash
claude mcp add --transport http gainium http://mcp.gainium.io/mcp
```

If your Claude Code setup supports header configuration in its MCP config, add the same `X-API-Key` and `X-API-Secret` headers shown in the generic remote HTTP examples.

### Claude Code with local stdio

Example CLI pattern:

```bash
claude mcp add gainium -- npx -y gainium-mcp
```

Then make sure the environment that launches Claude Code has:

```bash
export GAINIUM_API_KEY=YOUR_GAINIUM_API_KEY
export GAINIUM_API_SECRET=YOUR_GAINIUM_API_SECRET
```

### Claude Code notes

- Prefer remote HTTP for hosted deployments
- Prefer `stdio` for local development
- Use SSE only if your environment or version cannot use HTTP MCP

## OpenClaw

OpenClaw typically uses MCP server definitions in `.mcp.json` or a user-scoped MCP config, depending on installation.

### OpenClaw with local stdio

```json
{
  "gainium": {
    "command": "npx",
    "args": ["-y", "gainium-mcp"],
    "env": {
      "GAINIUM_API_KEY": "YOUR_GAINIUM_API_KEY",
      "GAINIUM_API_SECRET": "YOUR_GAINIUM_API_SECRET"
    }
  }
}
```

### OpenClaw with hosted remote HTTP

Use the equivalent remote MCP server entry supported by your OpenClaw build. The values should be:

- transport type: HTTP
- URL: `http://mcp.gainium.io/mcp`
- headers: `X-API-Key`, `X-API-Secret`

### OpenClaw with SSE

If your OpenClaw build only supports the legacy SSE pattern, use:

- SSE URL: `http://127.0.0.1:3000/sse` for a local server
- Messages URL: `http://127.0.0.1:3000/messages`

If your OpenClaw installation supports modern MCP HTTP, prefer `/mcp` instead.

## Claude Desktop and other desktop MCP clients

Many desktop MCP clients follow one of two models:

- Local child process via `command`, `args`, and `env`
- Remote HTTP server via `transport`, `url`, and optional headers

If your client supports local process launch, use the local `stdio` example.

If your client supports remote MCP over HTTP, use the hosted remote HTTP example.

If your client supports only SSE, use the local SSE endpoints.

## Generic connection patterns

### Generic local process client

```json
{
  "gainium": {
    "command": "npx",
    "args": ["-y", "gainium-mcp"],
    "env": {
      "GAINIUM_API_KEY": "YOUR_GAINIUM_API_KEY",
      "GAINIUM_API_SECRET": "YOUR_GAINIUM_API_SECRET"
    }
  }
}
```

### Generic remote HTTP client

```json
{
  "gainium": {
    "transport": "http",
    "url": "http://mcp.gainium.io/mcp",
    "headers": {
      "X-API-Key": "YOUR_GAINIUM_API_KEY",
      "X-API-Secret": "YOUR_GAINIUM_API_SECRET"
    }
  }
}
```

### Generic local HTTP client

```json
{
  "gainium": {
    "transport": "http",
    "url": "http://127.0.0.1:3000/mcp"
  }
}
```

### Generic legacy SSE client

Use:

- connect URL: `http://127.0.0.1:3000/sse`
- messages URL: `http://127.0.0.1:3000/messages`

## Tool Usage: Paper Mode and Bot IDs

These values are usually not part of the MCP connection config itself.

### Bot ID

Most write operations take `botId` as part of the tool input.

Examples:

- `start_bot`
- `stop_bot`
- `archive_bot`
- `restore_bot`
- `change_bot_pairs`
- `clone_dca_bot`

Example input:

```json
{
  "botId": "507f1f77bcf86cd799439011",
  "botType": "dca"
}
```

### Paper mode

For most relevant tools, paper trading is controlled with:

```json
{
  "paperContext": true
}
```

Example:

```json
{
  "botId": "507f1f77bcf86cd799439011",
  "botType": "dca",
  "paperContext": true
}
```

If you want paper mode to be enforced automatically, set `GAINIUM_PAPER_ONLY=true` on the server instance you run.

## Self-hosting a Locked-Down Remote Server

If you want a remote server that is already limited to one bot and paper trading only, run your own hosted instance like this:

```bash
export GAINIUM_API_KEY=YOUR_GAINIUM_API_KEY
export GAINIUM_API_SECRET=YOUR_GAINIUM_API_SECRET
export GAINIUM_ALLOWED_BOT_ID=507f1f77bcf86cd799439011
export GAINIUM_PAPER_ONLY=true
export GAINIUM_MCP_TRANSPORT=http
export GAINIUM_MCP_HOST=0.0.0.0
export GAINIUM_MCP_PORT=3000
export GAINIUM_MCP_HTTP_PATH=/mcp
node dist/server.js
```

Then point clients to:

```text
http://your-server:3000/mcp
```

In this setup:

- The server already knows the Gainium API credentials
- The server is already locked to one bot
- The server already forces paper trading
- Clients only need MCP connectivity to your endpoint

## Troubleshooting

### Error: missing Gainium credentials

Cause:

- Local mode is missing `GAINIUM_API_KEY` or `GAINIUM_API_SECRET`
- Remote mode is missing `X-API-Key` or `X-API-Secret`

Fix:

- For local `stdio` or local HTTP, set the env vars on the server process
- For hosted remote HTTP, add the two request headers in client config

### Tool works locally but not against hosted remote

Cause:

- Hosted server may not have the same env restrictions or defaults
- Your client may not be sending headers

Fix:

- Verify `X-API-Key` and `X-API-Secret`
- Verify the exact remote URL, usually `http://mcp.gainium.io/mcp`
- Pass `paperContext: true` explicitly where needed

### Client does not support HTTP MCP

Fix:

- Use local `stdio` if supported
- If it only supports SSE, use local HTTP mode and connect to `/sse`
- If it only supports `stdio` but you must consume a remote MCP, use an MCP gateway or wrapper that bridges remote transports to local `stdio`

### Can I put the MCP endpoint at `/` instead of `/mcp`?

Yes. Set:

```bash
export GAINIUM_MCP_HTTP_PATH=/
```

There is no code-level issue with this, but `/mcp` is a better default for public deployments because it is clearer and leaves `/` available for other routing later.

## Recommended Defaults

For most users:

- Local development: use `stdio`
- Private reusable local server: use HTTP on `/mcp`
- Hosted shared deployment: use remote HTTP on `/mcp`
- Legacy compatibility only: use SSE

For most secure behavior:

- Keep credentials local when possible
- Use a self-hosted HTTP instance if you need server-side bot restriction or forced paper mode
- Prefer `paperContext: true` explicitly for paper workflows unless the server is already paper-locked
