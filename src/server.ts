import express, { Request, Response } from 'express';
import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';

dotenv.config();

// Environment variables validation
const envSchema = z.object({
  GAINIUM_API_BASE_URL: z.string().url(),
  GAINIUM_API_KEY: z.string().min(1),
  GAINIUM_API_SECRET: z.string().min(1),
  PORT: z.string().default('3333'),
});

const env = envSchema.parse(process.env);

// Types
interface DcaBot {
  id: string;
  name: string;
  status: string;
  pnl: number;
}

// Gainium API client
class GainiumClient {
  private baseUrl: string;
  private apiKey: string;
  private apiSecret: string;

  constructor(baseUrl: string, apiKey: string, apiSecret: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  private async makeRequest<T>(endpoint: string, queryString: string = '', method: string = 'GET', body: string = ''): Promise<T> {
    const fullEndpoint = endpoint + queryString;
    const url = `${this.baseUrl}${fullEndpoint}`;
    const timestamp = Date.now();
    
    // Create signature: HMAC SHA256 of (body + method + endpoint + querystring + timestamp)
    // This matches the n8n implementation
    const prehash = body + method + fullEndpoint + timestamp;
    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(prehash)
      .digest('base64');
    
    console.error(`[Gainium API] Calling: ${method} ${url}`);
    console.error(`[Gainium API] Timestamp: ${timestamp}`);
    console.error(`[Gainium API] Prehash: ${prehash}`);

    try {
      const fetchOptions: any = {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Token': this.apiKey,
          'Time': timestamp.toString(),
          'Signature': signature,
        },
      };
      
      // Only include body if it's not empty and not a GET request
      if (body && method !== 'GET') {
        fetchOptions.body = body;
      }
      
      const response = await fetch(url, fetchOptions);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Gainium API] Error response: ${response.status} - ${errorText}`);
        throw new Error(`Gainium API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      console.error(`[Gainium API] Success: received data`);
      return data as T;
    } catch (error) {
      console.error(`[Gainium API] Request failed:`, error);
      throw error;
    }
  }

  async listDcaBots(): Promise<DcaBot[]> {
    const endpoint = '/api/bots/dca';
    const queryString = '?paperContext=false&page=1';
    const method = 'GET';
    const body = '';
    
    const response = await this.makeRequest<any>(endpoint, queryString, method, body);
    
    // Extract only the required fields
    if (Array.isArray(response)) {
      return response.map(bot => ({
        id: bot.id,
        name: bot.name,
        status: bot.status,
        pnl: bot.pnl,
      }));
    }
    
    // Handle case where response might be wrapped in data.result or data.items
    if (response.data) {
      let bots = [];
      if (response.data.result && Array.isArray(response.data.result)) {
        bots = response.data.result;
      } else if (response.data.items && Array.isArray(response.data.items)) {
        bots = response.data.items;
      } else if (Array.isArray(response.data)) {
        bots = response.data;
      }
      
      return bots.map((bot: any) => ({
        id: bot.id,
        name: bot.name,
        status: bot.status,
        pnl: bot.pnl,
      }));
    }
    
    console.error('[Gainium API] Unexpected response format:', response);
    return [];
  }
}

// Initialize Gainium client
const gainiumClient = new GainiumClient(
  env.GAINIUM_API_BASE_URL,
  env.GAINIUM_API_KEY,
  env.GAINIUM_API_SECRET
);

// Express app setup
const app = express();
app.use(express.json());

app.post('/mcp', async (req: Request, res: Response) => {
  console.error('[HTTP] Received MCP request');
  
  try {
    const mcpRequest = req.body;
    
    // Manually route based on method
    let result;
    
    if (mcpRequest.method === 'tools/list') {
      console.error('[MCP] Listing tools');
      result = {
        tools: [
          {
            name: 'list_dca_bots',
            description: 'List all DCA bots with their id, name, status, and PnL',
            inputSchema: {
              type: 'object',
              properties: {},
              required: [],
            },
          },
        ],
      };
    } else if (mcpRequest.method === 'tools/call') {
      const toolName = mcpRequest.params?.name;
      console.error(`[MCP] Tool called: ${toolName}`);

      if (toolName === 'list_dca_bots') {
        try {
          const bots = await gainiumClient.listDcaBots();
          result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(bots, null, 2),
              },
            ],
          };
        } catch (error) {
          console.error(`[MCP] Tool execution error:`, error);
          result = {
            content: [
              {
                type: 'text',
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      } else {
        throw new Error(`Unknown tool: ${toolName}`);
      }
    } else {
      throw new Error(`Unsupported method: ${mcpRequest.method}`);
    }
    
    res.json(result);
  } catch (error) {
    console.error('[HTTP] Error handling request:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
const port = parseInt(env.PORT, 10);
app.listen(port, () => {
  console.error(`[Server] MCP server listening at http://localhost:${port}/mcp`);
  console.error(`[Server] Health check available at http://localhost:${port}/health`);
});
