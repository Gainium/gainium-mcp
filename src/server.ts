#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { GainiumClient } from "./gainium-client.js";

// ── Environment ──────────────────────────────────────────────────────────────

const API_KEY = process.env.GAINIUM_API_KEY;
const API_SECRET = process.env.GAINIUM_API_SECRET;
const BASE_URL =
  process.env.GAINIUM_API_BASE_URL || "https://api.gainium.io";

if (!API_KEY || !API_SECRET) {
  console.error(
    "[gainium-mcp] Missing required environment variables: GAINIUM_API_KEY, GAINIUM_API_SECRET"
  );
  process.exit(1);
}

const client = new GainiumClient(BASE_URL, API_KEY, API_SECRET);

// ── Shared schema fragments ─────────────────────────────────────────────────

const fieldsParam = {
  fields: {
    type: "string" as const,
    description:
      'Field selection: preset ("minimal", "standard", "extended", "full") or comma-separated fields (e.g. "_id,uuid,settings.name,profit.total"). Default: "standard"',
  },
};

const pageParam = {
  page: {
    type: "integer" as const,
    description: "Page number for pagination (1-based). Default: 1",
  },
};

const statusParam = {
  status: {
    type: "string" as const,
    enum: ["open", "closed", "range", "error", "archive", "monitoring"],
    description: "Filter by bot status",
  },
};

const paperContextParam = {
  paperContext: {
    type: "boolean" as const,
    description:
      "Filter by paper trading context (true = paper, false = real). Default: false",
  },
};

const botIdRequired = {
  botId: {
    type: "string" as const,
    description: "Bot ID (UUID or MongoDB _id)",
  },
};

const botTypeParam = (types: string[], defaultVal: string) => ({
  botType: {
    type: "string" as const,
    enum: types,
    description: `Bot type. Default: "${defaultVal}"`,
  },
});

// ── Tool Definitions ────────────────────────────────────────────────────────

const tools: Tool[] = [
  // ─── BOT LISTING ────────────────────────────────────────────────────────

  {
    name: "get_dca_bots",
    description:
      "List DCA (Dollar Cost Averaging) bots. Supports field selection presets: minimal (~85% smaller), standard (default), extended, full. Supports filtering by status and paper/real trading context.",
    inputSchema: {
      type: "object",
      properties: {
        ...fieldsParam,
        ...pageParam,
        ...statusParam,
        ...paperContextParam,
      },
    },
  },
  {
    name: "get_combo_bots",
    description:
      "List Combo (Long/Short with grid-level) bots. Supports field selection presets: minimal, standard (default), extended, full.",
    inputSchema: {
      type: "object",
      properties: {
        ...fieldsParam,
        ...pageParam,
        ...statusParam,
        ...paperContextParam,
      },
    },
  },
  {
    name: "get_grid_bots",
    description:
      "List Grid bots. Supports field selection presets: minimal, standard (default), extended, full.",
    inputSchema: {
      type: "object",
      properties: {
        ...fieldsParam,
        ...pageParam,
        ...statusParam,
        ...paperContextParam,
      },
    },
  },

  // ─── BOT CREATION ──────────────────────────────────────────────────────

  {
    name: "create_dca_bot",
    description:
      "Create a new DCA bot. Requires write API key permission. The 'futures' and 'coinm' fields are auto-detected from the exchange — do not provide them.",
    inputSchema: {
      type: "object",
      properties: {
        exchangeUUID: {
          type: "string",
          description: "UUID of the exchange connection to use",
        },
        paperContext: {
          type: "boolean",
          description: "Create in paper trading mode. Default: false",
        },
        pair: {
          type: "array",
          items: { type: "string" },
          description:
            'Trading pairs in {base}_{quote} format, e.g. ["BTC_USDT"]',
        },
        name: { type: "string", description: "Bot name" },
        strategy: {
          type: "string",
          enum: ["LONG", "SHORT"],
          description: "Trading direction. Default: LONG",
        },
        baseOrderSize: {
          type: "string",
          description: 'Size of the initial base order, e.g. "100"',
        },
        orderSize: {
          type: "string",
          description: 'Size of each DCA order, e.g. "100"',
        },
        orderSizeType: {
          type: "string",
          enum: ["base", "quote", "percFree", "percTotal", "usd"],
          description: "Order size reference currency. Default: quote",
        },
        tpPerc: {
          type: "string",
          description: 'Take profit percentage, e.g. "1.5"',
        },
        slPerc: {
          type: "string",
          description: 'Stop loss percentage, e.g. "-10"',
        },
        step: {
          type: "string",
          description: 'Price deviation % for next DCA order, e.g. "1.5"',
        },
        ordersCount: {
          type: "integer",
          description: "Maximum number of DCA orders",
        },
        maxNumberOfOpenDeals: {
          type: "string",
          description: 'Maximum concurrent open deals, e.g. "1"',
        },
        startCondition: {
          type: "string",
          enum: [
            "ASAP",
            "Manual",
            "TradingviewSignals",
            "Timer",
            "TechnicalIndicators",
          ],
          description: "Condition to start a new deal. Default: ASAP",
        },
        settings: {
          type: "object",
          description:
            "Additional DCA bot settings (any DCABotSettings fields not listed above). Merged into the request body.",
        },
      },
      required: ["exchangeUUID", "pair"],
    },
  },
  {
    name: "create_combo_bot",
    description:
      "Create a new Combo bot (DCA + grid levels). Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        exchangeUUID: {
          type: "string",
          description: "UUID of the exchange connection",
        },
        paperContext: {
          type: "boolean",
          description: "Create in paper trading mode. Default: false",
        },
        pair: {
          type: "array",
          items: { type: "string" },
          description: 'Trading pairs, e.g. ["BTC_USDT"]',
        },
        name: { type: "string", description: "Bot name" },
        strategy: {
          type: "string",
          enum: ["LONG", "SHORT"],
          description: "Trading direction",
        },
        baseOrderSize: { type: "string", description: "Base order size" },
        orderSize: { type: "string", description: "DCA order size" },
        gridLevel: {
          type: "string",
          description: 'Number of grid levels, e.g. "5"',
        },
        step: { type: "string", description: "Step % between DCA orders" },
        ordersCount: { type: "integer", description: "DCA orders count" },
        settings: {
          type: "object",
          description:
            "Additional Combo bot settings (ComboBotSettings fields). Merged into the request body.",
        },
      },
      required: ["exchangeUUID", "pair"],
    },
  },
  {
    name: "create_grid_bot",
    description:
      "Create a new Grid bot that buys/sells within a price range. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        exchangeUUID: {
          type: "string",
          description: "UUID of the exchange connection",
        },
        paperContext: {
          type: "boolean",
          description: "Create in paper trading mode. Default: false",
        },
        pair: {
          type: "string",
          description:
            'Trading pair in {base}_{quote} format, e.g. "BTC_USDT"',
        },
        topPrice: { type: "number", description: "Top price of grid range" },
        lowPrice: {
          type: "number",
          description: "Bottom price of grid range",
        },
        budget: {
          type: "number",
          description: "Total budget allocated to bot",
        },
        levels: { type: "number", description: "Number of grid levels" },
        name: { type: "string", description: "Bot name" },
        gridType: {
          type: "string",
          description: 'Grid type: "arithmetic" or "geometric"',
        },
        settings: {
          type: "object",
          description:
            "Additional Grid bot settings (BotSettings fields). Merged into the request body.",
        },
      },
      required: ["exchangeUUID", "pair", "topPrice", "lowPrice", "budget"],
    },
  },

  // ─── BOT UPDATE ─────────────────────────────────────────────────────────

  {
    name: "update_dca_bot",
    description:
      "Update an existing DCA bot's settings. Only include fields you want to change. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...botIdRequired,
        ...paperContextParam,
        settings: {
          type: "object",
          description:
            "Settings to update: name, pair, step, ordersCount, tpPerc, slPerc, orderSize, baseOrderSize, orderSizeType, startCondition, maxNumberOfOpenDeals, useTp, useSl, useDca, volumeScale, stepScale, etc.",
        },
      },
      required: ["botId", "settings"],
    },
  },
  {
    name: "update_combo_bot",
    description:
      "Update an existing Combo bot's settings. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...botIdRequired,
        ...paperContextParam,
        settings: {
          type: "object",
          description:
            "Settings to update: name, step, ordersCount, tpPerc, slPerc, orderSize, baseOrderSize, gridLevel, baseStep, baseGridLevels, comboTpBase, etc.",
        },
      },
      required: ["botId", "settings"],
    },
  },

  // ─── BOT CLONE ──────────────────────────────────────────────────────────

  {
    name: "clone_dca_bot",
    description:
      "Clone a DCA bot, optionally overriding settings. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...botIdRequired,
        ...paperContextParam,
        overrides: {
          type: "object",
          description:
            "Settings to override in the cloned bot (UpdateDCABotInput fields)",
        },
      },
      required: ["botId"],
    },
  },
  {
    name: "clone_combo_bot",
    description:
      "Clone a Combo bot, optionally overriding settings. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...botIdRequired,
        ...paperContextParam,
        overrides: {
          type: "object",
          description:
            "Settings to override in the cloned bot (UpdateComboBotInput fields, plus pair array)",
        },
      },
      required: ["botId"],
    },
  },

  // ─── BOT LIFECYCLE ──────────────────────────────────────────────────────

  {
    name: "start_bot",
    description: "Start a bot. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...botIdRequired,
        type: {
          type: "string",
          enum: ["dca", "grid", "combo"],
          description: "Bot type",
        },
        ...paperContextParam,
      },
      required: ["botId", "type"],
    },
  },
  {
    name: "stop_bot",
    description: "Stop a running bot. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...botIdRequired,
        ...botTypeParam(["dca", "combo", "grid"], "grid"),
        closeType: {
          type: "string",
          enum: ["cancel", "closeByLimit", "closeByMarket", "leave"],
          description: "How to close DCA/Combo open deals. Default: leave",
        },
        closeGridType: {
          type: "string",
          enum: ["cancel", "closeByLimit", "closeByMarket"],
          description: "How to close Grid orders. Default: cancel",
        },
        cancelPartiallyFilled: {
          type: "boolean",
          description:
            "For Grid bots: cancel partially filled orders. Default: false",
        },
        ...paperContextParam,
      },
      required: ["botId", "botType"],
    },
  },
  {
    name: "archive_bot",
    description:
      "Archive a stopped bot. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...botIdRequired,
        ...botTypeParam(["dca", "combo", "grid"], "grid"),
        ...paperContextParam,
      },
      required: ["botId", "botType"],
    },
  },
  {
    name: "restore_bot",
    description:
      "Restore an archived bot. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...botIdRequired,
        type: {
          type: "string",
          enum: ["dca", "combo", "grid"],
          description: "Bot type",
        },
        ...paperContextParam,
      },
      required: ["botId", "type"],
    },
  },
  {
    name: "change_bot_pairs",
    description:
      'Change trading pairs for a DCA or Combo bot. Pairs format: {base}_{quote} (e.g. "BTC_USDT"). Requires write API key permission.',
    inputSchema: {
      type: "object",
      properties: {
        botId: {
          type: "string",
          description:
            "Bot ID. Either botId or botName required (botId has priority)",
        },
        botName: {
          type: "string",
          description: "Bot name to search. Either botId or botName required",
        },
        pairsToSet: {
          type: "array",
          items: { type: "string" },
          description:
            "Pairs to set (replaces existing). Has priority over pairsToAdd/pairsToRemove.",
        },
        pairsToSetMode: {
          type: "string",
          enum: ["add", "remove", "replace"],
          description: "Mode for pairsToSet. Default: replace",
        },
        pairsToAdd: {
          type: "array",
          items: { type: "string" },
          description: "Pairs to add",
        },
        pairsToRemove: {
          type: "array",
          items: { type: "string" },
          description: "Pairs to remove",
        },
        ...paperContextParam,
      },
    },
  },

  // ─── DEALS LISTING ──────────────────────────────────────────────────────

  {
    name: "get_deals",
    description:
      "List deals (DCA and Combo) with filtering and field selection. Presets: minimal, standard (default), extended, full.",
    inputSchema: {
      type: "object",
      properties: {
        ...fieldsParam,
        ...pageParam,
        type: {
          type: "string",
          enum: ["dca", "combo"],
          description: "Filter by deal type",
        },
        status: {
          type: "string",
          enum: ["open", "closed", "start", "error", "canceled"],
          description: "Filter by deal status",
        },
        botId: {
          type: "string",
          description: "Filter by parent bot UUID",
        },
        terminal: {
          type: "boolean",
          description:
            "false = regular deals, true = terminal deals. Default: false",
        },
        ...paperContextParam,
      },
    },
  },

  // ─── DEAL CREATION & MANAGEMENT ─────────────────────────────────────────

  {
    name: "create_terminal_deal",
    description:
      "Create a one-time Terminal Deal for immediate execution. Unlike bots, it executes once and closes. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        exchangeUUID: {
          type: "string",
          description: "UUID of the exchange connection",
        },
        paperContext: {
          type: "boolean",
          description: "Paper trading mode. Default: false",
        },
        pair: {
          type: "array",
          items: { type: "string" },
          description: 'Trading pairs, e.g. ["BTC_USDT"]',
        },
        terminalDealType: {
          type: "string",
          enum: ["simple", "smart", "import"],
          description: "Terminal deal type",
        },
        strategy: {
          type: "string",
          enum: ["LONG", "SHORT"],
          description: "Trading direction",
        },
        baseOrderSize: { type: "string", description: "Base order size" },
        orderSize: { type: "string", description: "DCA order size" },
        tpPerc: { type: "string", description: "Take profit %" },
        slPerc: { type: "string", description: "Stop loss %" },
        settings: {
          type: "object",
          description:
            "Additional terminal deal settings (DCABotSettings fields). Merged into the request body.",
        },
      },
      required: ["exchangeUUID", "pair", "terminalDealType"],
    },
  },
  {
    name: "update_dca_deal",
    description:
      "Update settings of an active DCA deal. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        dealId: { type: "string", description: "Deal ID" },
        ...paperContextParam,
        settings: {
          type: "object",
          description:
            "Deal settings to update: ordersCount, step, tpPerc, slPerc, orderSize, useTp, useSl, useDca, activeOrdersCount, volumeScale, stepScale, useMultiTp, multiTp, useMultiSl, multiSl, trailingTp, trailingSl, moveSL, closeByTimer, dcaCondition, dcaCustom, etc.",
        },
      },
      required: ["dealId", "settings"],
    },
  },
  {
    name: "update_combo_deal",
    description:
      "Update settings of an active Combo deal. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        dealId: { type: "string", description: "Deal ID" },
        ...paperContextParam,
        settings: {
          type: "object",
          description:
            "Deal settings to update: ordersCount, step, tpPerc, slPerc, useTp, useSl, useDca, activeOrdersCount, volumeScale, stepScale, comboTpBase, etc.",
        },
      },
      required: ["dealId", "settings"],
    },
  },
  {
    name: "start_deal",
    description:
      "Start a new deal for a bot. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...botIdRequired,
        ...botTypeParam(["dca", "combo"], "dca"),
        symbol: {
          type: "string",
          description:
            'Symbol for multi-coin bots. Format: {base}_{quote}, e.g. "BTC_USDT"',
        },
        ...paperContextParam,
      },
      required: ["botId", "botType"],
    },
  },
  {
    name: "close_deal",
    description:
      "Close an active deal. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        dealId: { type: "string", description: "Deal ID to close" },
        type: {
          type: "string",
          enum: ["cancel", "closeByLimit", "closeByMarket", "leave"],
          description: "How to close the deal. Default: cancel",
        },
        ...botTypeParam(["dca", "combo"], "dca"),
        ...paperContextParam,
      },
      required: ["dealId", "type", "botType"],
    },
  },
  {
    name: "add_funds",
    description:
      "Add funds to an active deal. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...botIdRequired,
        dealId: {
          type: "string",
          description: "Deal ID (optional if symbol provided)",
        },
        qty: { type: "string", description: "Quantity to add" },
        type: {
          type: "string",
          enum: ["fixed", "perc"],
          description: 'Quantity type. Default: "fixed"',
        },
        asset: {
          type: "string",
          enum: ["base", "quote"],
          description: "Asset reference (required if type is fixed)",
        },
        symbol: {
          type: "string",
          description: 'Target symbol, e.g. "BTC_USDT"',
        },
        ...paperContextParam,
      },
      required: ["botId", "qty", "type"],
    },
  },
  {
    name: "reduce_funds",
    description:
      "Reduce funds from an active deal. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...botIdRequired,
        dealId: {
          type: "string",
          description: "Deal ID (optional if symbol provided)",
        },
        qty: { type: "string", description: "Quantity to reduce" },
        type: {
          type: "string",
          enum: ["fixed", "perc"],
          description: 'Quantity type. Default: "fixed"',
        },
        asset: {
          type: "string",
          enum: ["base", "quote"],
          description: "Asset reference (required if type is fixed)",
        },
        symbol: {
          type: "string",
          description: 'Target symbol, e.g. "BTC_USDT"',
        },
        ...paperContextParam,
      },
      required: ["botId", "qty", "type"],
    },
  },

  // ─── USER ───────────────────────────────────────────────────────────────

  {
    name: "get_balances",
    description:
      "Get user balances across all exchanges. Supports field selection and filtering by exchange, asset, or paper context.",
    inputSchema: {
      type: "object",
      properties: {
        ...fieldsParam,
        exchangeId: {
          type: "string",
          description: "Filter by exchange connection UUID",
        },
        asset: {
          type: "string",
          description: 'Filter by single asset, e.g. "BTC"',
        },
        assets: {
          type: "string",
          description: 'Filter by multiple assets, e.g. "BTC,USDT,ETH"',
        },
        ...paperContextParam,
      },
    },
  },
  {
    name: "get_user_exchanges",
    description: "Get user's connected exchange accounts.",
    inputSchema: {
      type: "object",
      properties: { ...paperContextParam },
    },
  },
  {
    name: "get_global_variables",
    description:
      "List user's global variables. Global variables can be referenced in bot configurations.",
    inputSchema: {
      type: "object",
      properties: { ...pageParam },
    },
  },
  {
    name: "create_global_variable",
    description:
      "Create a new global variable. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Variable name" },
        type: {
          type: "string",
          enum: ["text", "int", "float"],
          description: "Variable type",
        },
        value: {
          type: "string",
          description:
            "Variable value (always as string, validated against type)",
        },
      },
      required: ["name", "type", "value"],
    },
  },
  {
    name: "update_global_variable",
    description:
      "Update an existing global variable. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Variable ID" },
        name: { type: "string", description: "New name" },
        type: {
          type: "string",
          enum: ["text", "int", "float"],
          description: "New type",
        },
        value: { type: "string", description: "New value (must match type)" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_global_variable",
    description:
      "Delete a global variable. Must not be used by any bots. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Variable ID to delete" },
      },
      required: ["id"],
    },
  },

  // ─── GENERAL ────────────────────────────────────────────────────────────

  {
    name: "get_supported_exchanges",
    description: "Get a list of supported exchanges (code, market, type).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_screener",
    description:
      "Get crypto screener data with market metrics. Requires active subscription. Supports field selection and filters for category, market cap, volume, sorting.",
    inputSchema: {
      type: "object",
      properties: {
        ...fieldsParam,
        ...pageParam,
        category: {
          type: "string",
          description: 'Filter by category, e.g. "Layer 1", "DeFi"',
        },
        minMarketCap: {
          type: "number",
          description: "Minimum market cap",
        },
        maxMarketCap: {
          type: "number",
          description: "Maximum market cap",
        },
        minVolume: {
          type: "number",
          description: "Minimum 24h volume",
        },
        sort: {
          type: "string",
          enum: [
            "marketCapRank",
            "currentPrice",
            "priceChangePercentage24h",
            "totalVolume",
            "marketCap",
          ],
          description: "Sort field. Default: marketCapRank",
        },
        order: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Sort order. Default: asc",
        },
      },
    },
  },
];

// ── Tool Handlers ───────────────────────────────────────────────────────────

async function handleToolCall(
  name: string,
  args: Record<string, any>
): Promise<string> {
  switch (name) {
    // ── Bot Listing ──────────────────────────────────────────────────────

    case "get_dca_bots": {
      const res = await client.request("GET", "/api/v2/bots/dca", {
        query: {
          fields: args.fields,
          page: args.page,
          status: args.status,
          paperContext: args.paperContext,
        },
      });
      return JSON.stringify(res, null, 2);
    }

    case "get_combo_bots": {
      const res = await client.request("GET", "/api/v2/bots/combo", {
        query: {
          fields: args.fields,
          page: args.page,
          status: args.status,
          paperContext: args.paperContext,
        },
      });
      return JSON.stringify(res, null, 2);
    }

    case "get_grid_bots": {
      const res = await client.request("GET", "/api/v2/bots/grid", {
        query: {
          fields: args.fields,
          page: args.page,
          status: args.status,
          paperContext: args.paperContext,
        },
      });
      return JSON.stringify(res, null, 2);
    }

    // ── Bot Creation ─────────────────────────────────────────────────────

    case "create_dca_bot": {
      const { settings = {}, ...topLevel } = args;
      const body = { ...settings, ...topLevel };
      delete body.settings;
      const res = await client.request("POST", "/api/v2/createDCABot", {
        body,
      });
      return JSON.stringify(res, null, 2);
    }

    case "create_combo_bot": {
      const { settings = {}, ...topLevel } = args;
      const body = { ...settings, ...topLevel };
      delete body.settings;
      const res = await client.request("POST", "/api/v2/createComboBot", {
        body,
      });
      return JSON.stringify(res, null, 2);
    }

    case "create_grid_bot": {
      const { settings = {}, ...topLevel } = args;
      const body = { ...settings, ...topLevel };
      delete body.settings;
      const res = await client.request("POST", "/api/v2/createGridBot", {
        body,
      });
      return JSON.stringify(res, null, 2);
    }

    // ── Bot Update ───────────────────────────────────────────────────────

    case "update_dca_bot": {
      const res = await client.request("POST", "/api/v2/updateDCABot", {
        query: { botId: args.botId, paperContext: args.paperContext },
        body: args.settings,
      });
      return JSON.stringify(res, null, 2);
    }

    case "update_combo_bot": {
      const res = await client.request("POST", "/api/v2/updateComboBot", {
        query: { botId: args.botId, paperContext: args.paperContext },
        body: args.settings,
      });
      return JSON.stringify(res, null, 2);
    }

    // ── Bot Clone ────────────────────────────────────────────────────────

    case "clone_dca_bot": {
      const res = await client.request("PUT", "/api/v2/cloneDCABot", {
        query: { botId: args.botId, paperContext: args.paperContext },
        body: args.overrides || {},
      });
      return JSON.stringify(res, null, 2);
    }

    case "clone_combo_bot": {
      const res = await client.request("PUT", "/api/v2/cloneComboBot", {
        query: { botId: args.botId, paperContext: args.paperContext },
        body: args.overrides || {},
      });
      return JSON.stringify(res, null, 2);
    }

    // ── Bot Lifecycle ────────────────────────────────────────────────────

    case "start_bot": {
      const res = await client.request("POST", "/api/v2/startBot", {
        query: {
          botId: args.botId,
          type: args.type,
          paperContext: args.paperContext,
        },
      });
      return JSON.stringify(res, null, 2);
    }

    case "stop_bot": {
      const res = await client.request("DELETE", "/api/v2/stopBot", {
        query: {
          botId: args.botId,
          botType: args.botType,
          closeType: args.closeType,
          closeGridType: args.closeGridType,
          cancelPartiallyFilled: args.cancelPartiallyFilled,
          paperContext: args.paperContext,
        },
      });
      return JSON.stringify(res, null, 2);
    }

    case "archive_bot": {
      const res = await client.request("DELETE", "/api/v2/archiveBot", {
        query: {
          botId: args.botId,
          botType: args.botType,
          paperContext: args.paperContext,
        },
      });
      return JSON.stringify(res, null, 2);
    }

    case "restore_bot": {
      const res = await client.request("POST", "/api/v2/restoreBot", {
        query: {
          botId: args.botId,
          type: args.type,
          paperContext: args.paperContext,
        },
      });
      return JSON.stringify(res, null, 2);
    }

    case "change_bot_pairs": {
      const query: Record<string, any> = {
        botId: args.botId,
        botName: args.botName,
        paperContext: args.paperContext,
        pairsToSetMode: args.pairsToSetMode,
      };
      if (args.pairsToSet) query.pairsToSet = args.pairsToSet;
      if (args.pairsToAdd) query["pairsToChange[add]"] = args.pairsToAdd;
      if (args.pairsToRemove)
        query["pairsToChange[remove]"] = args.pairsToRemove;
      const res = await client.request("POST", "/api/v2/changeBotPairs", {
        query,
      });
      return JSON.stringify(res, null, 2);
    }

    // ── Deals Listing ────────────────────────────────────────────────────

    case "get_deals": {
      const res = await client.request("GET", "/api/v2/deals", {
        query: {
          fields: args.fields,
          page: args.page,
          type: args.type,
          status: args.status,
          botId: args.botId,
          terminal: args.terminal,
          paperContext: args.paperContext,
        },
      });
      return JSON.stringify(res, null, 2);
    }

    // ── Deal Creation & Management ───────────────────────────────────────

    case "create_terminal_deal": {
      const { settings = {}, ...topLevel } = args;
      const body = { ...settings, ...topLevel };
      delete body.settings;
      const res = await client.request("POST", "/api/v2/createTerminalDeal", {
        body,
      });
      return JSON.stringify(res, null, 2);
    }

    case "update_dca_deal": {
      const res = await client.request("POST", "/api/v2/updateDCADeal", {
        query: { dealId: args.dealId, paperContext: args.paperContext },
        body: args.settings,
      });
      return JSON.stringify(res, null, 2);
    }

    case "update_combo_deal": {
      const res = await client.request("POST", "/api/v2/updateComboDeal", {
        query: { dealId: args.dealId, paperContext: args.paperContext },
        body: args.settings,
      });
      return JSON.stringify(res, null, 2);
    }

    case "start_deal": {
      const res = await client.request("POST", "/api/v2/startDeal", {
        query: {
          botId: args.botId,
          botType: args.botType,
          symbol: args.symbol,
          paperContext: args.paperContext,
        },
      });
      return JSON.stringify(res, null, 2);
    }

    case "close_deal": {
      const res = await client.request(
        "DELETE",
        `/api/v2/closeDeal/${args.dealId}`,
        {
          query: {
            type: args.type,
            botType: args.botType,
            paperContext: args.paperContext,
          },
        }
      );
      return JSON.stringify(res, null, 2);
    }

    case "add_funds": {
      const res = await client.request("POST", "/api/v2/addFunds", {
        query: {
          botId: args.botId,
          dealId: args.dealId,
          qty: args.qty,
          type: args.type,
          asset: args.asset,
          symbol: args.symbol,
          paperContext: args.paperContext,
        },
      });
      return JSON.stringify(res, null, 2);
    }

    case "reduce_funds": {
      const res = await client.request("POST", "/api/v2/reduceFunds", {
        query: {
          botId: args.botId,
          dealId: args.dealId,
          qty: args.qty,
          type: args.type,
          asset: args.asset,
          symbol: args.symbol,
          paperContext: args.paperContext,
        },
      });
      return JSON.stringify(res, null, 2);
    }

    // ── User ─────────────────────────────────────────────────────────────

    case "get_balances": {
      const res = await client.request("GET", "/api/v2/user/balances", {
        query: {
          fields: args.fields,
          exchangeId: args.exchangeId,
          asset: args.asset,
          assets: args.assets,
          paperContext: args.paperContext,
        },
      });
      return JSON.stringify(res, null, 2);
    }

    case "get_user_exchanges": {
      const res = await client.request("GET", "/api/v2/user/exchanges", {
        query: { paperContext: args.paperContext },
      });
      return JSON.stringify(res, null, 2);
    }

    case "get_global_variables": {
      const res = await client.request("GET", "/api/v2/user/globalVars", {
        query: { page: args.page },
      });
      return JSON.stringify(res, null, 2);
    }

    case "create_global_variable": {
      const res = await client.request("POST", "/api/v2/user/globalVars", {
        body: { name: args.name, type: args.type, value: args.value },
      });
      return JSON.stringify(res, null, 2);
    }

    case "update_global_variable": {
      const body: Record<string, any> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.type !== undefined) body.type = args.type;
      if (args.value !== undefined) body.value = args.value;
      const res = await client.request(
        "PUT",
        `/api/v2/user/globalVars/${args.id}`,
        { body }
      );
      return JSON.stringify(res, null, 2);
    }

    case "delete_global_variable": {
      const res = await client.request(
        "DELETE",
        `/api/v2/user/globalVars/${args.id}`
      );
      return JSON.stringify(res, null, 2);
    }

    // ── General ──────────────────────────────────────────────────────────

    case "get_supported_exchanges": {
      const res = await client.request("GET", "/api/v2/exchanges");
      return JSON.stringify(res, null, 2);
    }

    case "get_screener": {
      const res = await client.request("GET", "/api/v2/screener", {
        query: {
          fields: args.fields,
          page: args.page,
          category: args.category,
          minMarketCap: args.minMarketCap,
          maxMarketCap: args.maxMarketCap,
          minVolume: args.minVolume,
          sort: args.sort,
          order: args.order,
        },
      });
      return JSON.stringify(res, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP Server Setup ────────────────────────────────────────────────────────

const server = new Server(
  { name: "gainium-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: toolArgs } = request.params;
  try {
    const result = await handleToolCall(name, toolArgs ?? {});
    return { content: [{ type: "text" as const, text: result }] };
  } catch (error: any) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: ${error?.message ?? String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[gainium-mcp] Server started");
}

main().catch((err) => {
  console.error("[gainium-mcp] Fatal error:", err);
  process.exit(1);
});
