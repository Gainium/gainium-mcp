# Gainium MCP Server

A local HTTP MCP server that connects to the Gainium backend API.

## Features

- Read-only access to Gainium DCA bots
- HTTP-based MCP server running locally
- Clean error handling and validation with Zod
- TypeScript implementation

## Prerequisites

- Node.js (v18 or higher)
- npm or yarn

## Installation

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory:
```bash
cp .env.example .env
```

3. Edit `.env` with your Gainium API credentials:
```
GAINIUM_API_BASE_URL=https://api.gainium.io
GAINIUM_API_KEY=your_api_key_here
GAINIUM_API_SECRET=your_api_secret_here
PORT=3333
```

## Running the Server

1. Build the TypeScript code:
```bash
npm run build
```

2. Start the server:
```bash
npm start
```

Or use the combined command:
```bash
npm run dev
```

The server will start at `http://localhost:3333/mcp`

## Testing

### Health Check

```bash
curl http://localhost:3333/health
```

### List Tools (MCP)

```bash
curl -X POST http://localhost:3333/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list",
    "params": {}
  }'
```

### Call list_dca_bots Tool

```bash
curl -X POST http://localhost:3333/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "list_dca_bots",
      "arguments": {}
    }
  }'
```

## Testing with MCP Inspector

1. Install MCP Inspector globally:
```bash
npm install -g @modelcontextprotocol/inspector
```

2. Run the inspector:
```bash
mcp-inspector
```

3. Configure the connection:
   - Connection Type: HTTP
   - URL: `http://localhost:3333/mcp`

## Available MCP Tools

### list_dca_bots

Lists all DCA bots with their basic information.

**Response Fields:**
- `id`: Bot identifier
- `name`: Bot name
- `status`: Bot status
- `pnl`: Profit and Loss

## Architecture

```
gainium-mcp/
├── src/
│   └── server.ts       # Main MCP server implementation
├── dist/               # Compiled JavaScript (generated)
├── .env                # Environment variables (not in git)
├── .env.example        # Environment template
├── package.json        # Dependencies and scripts
├── tsconfig.json       # TypeScript configuration
└── README.md           # This file
```

## Error Handling

All errors are logged to stderr and returned in the MCP response format. The server handles:
- Invalid API credentials
- Network failures
- Malformed requests
- Unknown tools

## Notes

- This is a read-only server - no write operations are supported
- All API calls are made directly to the live Gainium backend
- Authentication uses API key and secret headers
- Logs are written to stderr only
