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

// ── Helpers ─────────────────────────────────────────────────────────────────

function paperHeader(
  args: Record<string, any>
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (args.paperContext !== undefined && args.paperContext !== null) {
    headers["paper-context"] = String(args.paperContext);
  }
  return headers;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasKeys(value: unknown): value is Record<string, any> {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function validateToolArgs(name: string, args: Record<string, any>): void {
  if (
    ["update_dca_bot", "update_combo_bot", "update_dca_deal", "update_combo_deal", "update_terminal_deal"].includes(
      name
    )
  ) {
    if (!hasKeys(args.settings)) {
      throw new Error("'settings' must be a non-empty object");
    }
  }

  if (["clone_dca_bot", "clone_combo_bot", "clone_grid_bot"].includes(name)) {
    if (!isNonEmptyString(args.botId)) {
      throw new Error("'botId' is required");
    }
    if (args.overrides !== undefined && !isPlainObject(args.overrides)) {
      throw new Error("'overrides' must be an object when provided");
    }
  }

  if (["start_bot", "stop_bot", "archive_bot", "restore_bot"].includes(name)) {
    if (!isNonEmptyString(args.botId)) {
      throw new Error("'botId' is required");
    }
    if (!isNonEmptyString(args.botType)) {
      throw new Error("'botType' is required");
    }
  }

  if (name === "change_bot_pairs") {
    if (!isNonEmptyString(args.botId)) {
      throw new Error("'botId' is required");
    }
    if (!Array.isArray(args.pair) || args.pair.length === 0) {
      throw new Error("'pair' must be a non-empty array");
    }
  }

  if (name === "start_deal") {
    if (!isNonEmptyString(args.botId)) {
      throw new Error("'botId' is required");
    }
    if (!isNonEmptyString(args.botType)) {
      throw new Error("'botType' is required");
    }
  }

  if (name === "close_deal") {
    if (!isNonEmptyString(args.dealId)) {
      throw new Error("'dealId' is required");
    }
    if (!isNonEmptyString(args.dealType)) {
      throw new Error("'dealType' is required");
    }
    if (!isNonEmptyString(args.type)) {
      throw new Error("'type' is required");
    }
  }

  if (["add_funds", "reduce_funds"].includes(name)) {
    if (!isNonEmptyString(args.qty)) {
      throw new Error("'qty' is required");
    }
    if (!isNonEmptyString(args.dealId) && !isNonEmptyString(args.botId)) {
      throw new Error("Either 'dealId' or 'botId' is required");
    }
    const fundsType = isNonEmptyString(args.type) ? args.type : "fixed";
    if (fundsType === "fixed" && !isNonEmptyString(args.asset)) {
      throw new Error("'asset' is required when type is 'fixed'");
    }
  }

  if (["add_funds_terminal", "reduce_funds_terminal"].includes(name)) {
    if (!isNonEmptyString(args.dealId)) {
      throw new Error("'dealId' is required");
    }
    if (!isNonEmptyString(args.qty)) {
      throw new Error("'qty' is required");
    }
    const fundsType = isNonEmptyString(args.type) ? args.type : "fixed";
    if (fundsType === "fixed" && !isNonEmptyString(args.asset)) {
      throw new Error("'asset' is required when type is 'fixed'");
    }
  }

  if (["estimate_backtest_cost", "request_backtest", "request_backtest_sync"].includes(name)) {
    if (!isNonEmptyString(args.botType)) {
      throw new Error("'botType' is required");
    }
    if (!hasKeys(args.payload)) {
      throw new Error("'payload' must be a non-empty object");
    }
  }

  if (name === "validate_backtest_payload") {
    if (!isNonEmptyString(args.botType)) {
      throw new Error("'botType' is required");
    }
    if (!hasKeys(args.payload)) {
      throw new Error("'payload' must be a non-empty object");
    }
  }

  if (name === "get_backtest_requests") {
    if (!isNonEmptyString(args.botType)) {
      throw new Error("'botType' is required");
    }
  }

  if (name === "get_backtest_request") {
    if (!isNonEmptyString(args.botType)) {
      throw new Error("'botType' is required");
    }
    if (!isNonEmptyString(args.id)) {
      throw new Error("'id' is required");
    }
  }

  if (["get_discovery_bot", "get_discovery_bot_sections"].includes(name)) {
    if (!isNonEmptyString(args.botType)) {
      throw new Error("'botType' is required");
    }
  }

  if (name === "get_discovery_indicator") {
    if (!isNonEmptyString(args.type)) {
      throw new Error("'type' is required");
    }
  }

  if (name === "create_terminal_deal") {
    if (!isNonEmptyString(args.exchangeUUID)) {
      throw new Error("'exchangeUUID' is required");
    }
    if (!isNonEmptyString(args.terminalDealType)) {
      throw new Error("'terminalDealType' is required");
    }
  }

  if (name === "create_global_variable") {
    if (!isNonEmptyString(args.name)) {
      throw new Error("'name' is required");
    }
    if (!isNonEmptyString(args.type)) {
      throw new Error("'type' is required");
    }
    if (!isNonEmptyString(args.value)) {
      throw new Error("'value' is required");
    }
  }

  if (name === "update_global_variable") {
    if (!isNonEmptyString(args.id)) {
      throw new Error("'id' is required");
    }
    if (
      args.name === undefined &&
      args.type === undefined &&
      args.value === undefined
    ) {
      throw new Error("Provide at least one of: 'name', 'type', or 'value'");
    }
  }

  if (name === "delete_global_variable") {
    if (!isNonEmptyString(args.id)) {
      throw new Error("'id' is required");
    }
  }

  if (name === "get_balances") {
    if (isNonEmptyString(args.asset) && isNonEmptyString(args.assets)) {
      throw new Error("Use either 'asset' or 'assets', not both");
    }
  }
}

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

const botStatusParam = {
  status: {
    type: "string" as const,
    enum: ["open", "closed", "range", "error", "archive", "monitoring"],
    description: "Filter by bot status",
  },
};

const dealStatusParam = {
  status: {
    type: "string" as const,
    enum: ["open", "closed", "start", "error", "canceled"],
    description: "Filter by deal status",
  },
};

const paperContextParam = {
  paperContext: {
    type: "boolean" as const,
    description:
      "Paper trading context (true = paper, false = real). Default: false",
  },
};

const botIdRequired = {
  botId: {
    type: "string" as const,
    description: "Bot ID (MongoDB ObjectId)",
  },
};

const dealIdRequired = {
  dealId: {
    type: "string" as const,
    description: "Deal ID (MongoDB ObjectId)",
  },
};

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
        ...botStatusParam,
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
        ...botStatusParam,
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
        ...botStatusParam,
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
        ...paperContextParam,
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
        ...paperContextParam,
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
        ...paperContextParam,
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
          minProperties: 1,
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
          minProperties: 1,
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
  {
    name: "clone_grid_bot",
    description:
      "Clone a Grid bot, optionally overriding settings. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...botIdRequired,
        ...paperContextParam,
        overrides: {
          type: "object",
          description:
            "Settings to override in the cloned bot (CreateGridBotInput fields)",
        },
      },
      required: ["botId"],
    },
  },

  // ─── BOT LIFECYCLE ──────────────────────────────────────────────────────

  {
    name: "start_bot",
    description:
      "Start a stopped or paused bot. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...botIdRequired,
        botType: {
          type: "string",
          enum: ["dca", "combo", "grid"],
          description: "Bot type",
        },
        ...paperContextParam,
      },
      required: ["botId", "botType"],
    },
  },
  {
    name: "stop_bot",
    description: "Stop an active bot. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...botIdRequired,
        botType: {
          type: "string",
          enum: ["dca", "combo", "grid"],
          description: "Bot type",
        },
        ...paperContextParam,
      },
      required: ["botId", "botType"],
    },
  },
  {
    name: "archive_bot",
    description:
      "Archive a bot (soft delete). Can be restored later. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...botIdRequired,
        botType: {
          type: "string",
          enum: ["dca", "combo", "grid"],
          description: "Bot type",
        },
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
        botType: {
          type: "string",
          enum: ["dca", "combo", "grid"],
          description: "Bot type",
        },
        ...paperContextParam,
      },
      required: ["botId", "botType"],
    },
  },
  {
    name: "change_bot_pairs",
    description:
      'Change trading pairs for a DCA bot. Pairs format: {base}_{quote} (e.g. "BTC_USDT"). Requires write API key permission.',
    inputSchema: {
      type: "object",
      properties: {
        ...botIdRequired,
        pair: {
          type: "array",
          items: { type: "string" },
          description:
            'List of trading pairs, e.g. ["BTC_USDT", "ETH_USDT"]',
        },
        ...paperContextParam,
      },
      required: ["botId", "pair"],
    },
  },

  // ─── DEALS LISTING ──────────────────────────────────────────────────────

  {
    name: "get_dca_deals",
    description:
      "List DCA deals with filtering and field selection. Presets: minimal, standard (default), extended, full.",
    inputSchema: {
      type: "object",
      properties: {
        ...fieldsParam,
        ...pageParam,
        ...dealStatusParam,
        botId: {
          type: "string",
          description: "Filter by parent bot UUID",
        },
        ...paperContextParam,
      },
    },
  },
  {
    name: "get_combo_deals",
    description:
      "List Combo deals with filtering and field selection. Presets: minimal, standard (default), extended, full.",
    inputSchema: {
      type: "object",
      properties: {
        ...fieldsParam,
        ...pageParam,
        ...dealStatusParam,
        botId: {
          type: "string",
          description: "Filter by parent bot UUID",
        },
        ...paperContextParam,
      },
    },
  },
  {
    name: "get_terminal_deals",
    description:
      "List Terminal deals (one-time trades) with filtering and field selection. Presets: minimal, standard (default), extended, full.",
    inputSchema: {
      type: "object",
      properties: {
        ...fieldsParam,
        ...pageParam,
        ...dealStatusParam,
        botId: {
          type: "string",
          description: "Filter by bot ID",
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
        ...paperContextParam,
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
      required: ["exchangeUUID", "terminalDealType"],
    },
  },
  {
    name: "update_dca_deal",
    description:
      "Update settings of an active DCA deal. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...dealIdRequired,
        ...paperContextParam,
        settings: {
          type: "object",
          minProperties: 1,
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
        ...dealIdRequired,
        ...paperContextParam,
        settings: {
          type: "object",
          minProperties: 1,
          description:
            "Deal settings to update: ordersCount, step, tpPerc, slPerc, useTp, useSl, useDca, activeOrdersCount, volumeScale, stepScale, comboTpBase, etc.",
        },
      },
      required: ["dealId", "settings"],
    },
  },
  {
    name: "update_terminal_deal",
    description:
      "Update settings of an active Terminal deal. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...dealIdRequired,
        ...paperContextParam,
        settings: {
          type: "object",
          minProperties: 1,
          description:
            "Deal settings to update: ordersCount, step, tpPerc, slPerc, useTp, useSl, useDca, activeOrdersCount, etc.",
        },
      },
      required: ["dealId", "settings"],
    },
  },
  {
    name: "start_deal",
    description:
      "Start a new deal from a bot. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...botIdRequired,
        botType: {
          type: "string",
          enum: ["dca", "combo"],
          description: "Bot type (dca or combo)",
        },
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
        ...dealIdRequired,
        dealType: {
          type: "string",
          enum: ["dca", "combo", "terminal"],
          description: "Deal type",
        },
        type: {
          type: "string",
          enum: ["cancel", "closeByLimit", "closeByMarket", "leave"],
          description: "Close type. Default: closeByMarket",
        },
        ...paperContextParam,
      },
      required: ["dealId", "dealType", "type"],
    },
  },
  {
    name: "add_funds",
    description:
      "Add funds to an active DCA deal. Either dealId or botId required. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        dealId: {
          type: "string",
          description: "Deal ID. Either dealId or botId required.",
        },
        botId: {
          type: "string",
          description: "Bot ID. Either dealId or botId required.",
        },
        qty: { type: "string", description: "Amount to add" },
        type: {
          type: "string",
          enum: ["fixed", "perc"],
          description: 'Quantity type. Default: "fixed"',
        },
        asset: {
          type: "string",
          enum: ["base", "quote"],
          description: "Asset type (required for fixed type)",
        },
        symbol: {
          type: "string",
          description: 'Trading symbol, e.g. "BTC_USDT"',
        },
        ...paperContextParam,
      },
      required: ["qty"],
      oneOf: [
        { required: ["dealId"] },
        { required: ["botId"] },
      ],
    },
  },
  {
    name: "reduce_funds",
    description:
      "Reduce funds from an active DCA deal. Either dealId or botId required. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        dealId: {
          type: "string",
          description: "Deal ID. Either dealId or botId required.",
        },
        botId: {
          type: "string",
          description: "Bot ID. Either dealId or botId required.",
        },
        qty: { type: "string", description: "Amount to reduce" },
        type: {
          type: "string",
          enum: ["fixed", "perc"],
          description: 'Quantity type. Default: "fixed"',
        },
        asset: {
          type: "string",
          enum: ["base", "quote"],
          description: "Asset type (required for fixed type)",
        },
        symbol: {
          type: "string",
          description: 'Trading symbol, e.g. "BTC_USDT"',
        },
        ...paperContextParam,
      },
      required: ["qty"],
      oneOf: [
        { required: ["dealId"] },
        { required: ["botId"] },
      ],
    },
  },
  {
    name: "add_funds_terminal",
    description:
      "Add funds to an active Terminal deal. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...dealIdRequired,
        qty: { type: "string", description: "Amount to add" },
        type: {
          type: "string",
          enum: ["fixed", "perc"],
          description: 'Quantity type. Default: "fixed"',
        },
        asset: {
          type: "string",
          enum: ["base", "quote"],
          description: "Asset type (required for fixed type)",
        },
        symbol: {
          type: "string",
          description: 'Trading symbol, e.g. "BTC_USDT"',
        },
      },
      required: ["dealId", "qty"],
    },
  },
  {
    name: "reduce_funds_terminal",
    description:
      "Reduce funds from an active Terminal deal. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        ...dealIdRequired,
        qty: { type: "string", description: "Amount to reduce" },
        type: {
          type: "string",
          enum: ["fixed", "perc"],
          description: 'Quantity type. Default: "fixed"',
        },
        asset: {
          type: "string",
          enum: ["base", "quote"],
          description: "Asset type (required for fixed type)",
        },
        symbol: {
          type: "string",
          description: 'Trading symbol, e.g. "BTC_USDT"',
        },
      },
      required: ["dealId", "qty"],
    },
  },

  // ─── BACKTEST ───────────────────────────────────────────────────────────

  {
    name: "estimate_backtest_cost",
    description:
      "Estimate the cost in credits for a server-side backtest before submitting. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        botType: {
          type: "string",
          enum: ["dca", "combo", "grid"],
          description: "Bot type for the backtest",
        },
        payload: {
          type: "object",
          minProperties: 1,
          description:
            "Backtest payload containing data (exchange, exchangeUUID, settings, from, to, interval)",
        },
        ...paperContextParam,
      },
      required: ["botType", "payload"],
    },
  },
  {
    name: "request_backtest",
    description:
      "Submit a server-side backtest request (async). Returns a requestId for tracking. Credits are deducted. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        botType: {
          type: "string",
          enum: ["dca", "combo", "grid"],
          description: "Bot type for the backtest",
        },
        payload: {
          type: "object",
          minProperties: 1,
          description:
            "Backtest payload containing data (exchange, exchangeUUID, settings, from, to, interval)",
        },
        ...paperContextParam,
      },
      required: ["botType", "payload"],
    },
  },
  {
    name: "request_backtest_sync",
    description:
      "Submit a server-side backtest and wait for result (synchronous, up to 1 hour). Returns the full backtest result when complete, or a requestId if timed out. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        botType: {
          type: "string",
          enum: ["dca", "combo", "grid"],
          description: "Bot type for the backtest",
        },
        payload: {
          type: "object",
          minProperties: 1,
          description:
            "Backtest payload containing data (exchange, exchangeUUID, settings, from, to, interval)",
        },
        ...fieldsParam,
        ...paperContextParam,
      },
      required: ["botType", "payload"],
    },
  },
  {
    name: "get_backtest_requests",
    description:
      "Get a paginated list of backtest requests for a bot type (10 per page, newest first). Supports field selection; use backtest.* prefixes to include linked backtest results.",
    inputSchema: {
      type: "object",
      properties: {
        botType: {
          type: "string",
          enum: ["dca", "combo", "grid"],
          description: "Bot type",
        },
        ...fieldsParam,
        ...pageParam,
        ...paperContextParam,
      },
      required: ["botType"],
    },
  },
  {
    name: "get_backtest_request",
    description:
      "Get a single backtest request by ID. Supports field selection; use backtest.* prefixes to include linked backtest results.",
    inputSchema: {
      type: "object",
      properties: {
        botType: {
          type: "string",
          enum: ["dca", "combo", "grid"],
          description: "Bot type",
        },
        id: {
          type: "string",
          description: "Backtest request MongoDB ObjectId",
        },
        ...fieldsParam,
      },
      required: ["botType", "id"],
    },
  },
  {
    name: "validate_backtest_payload",
    description:
      "Validate backtest bot settings without creating a bot or dispatching a backtest. Returns normalized settings after defaults are applied. Requires write API key permission.",
    inputSchema: {
      type: "object",
      properties: {
        botType: {
          type: "string",
          enum: ["dca", "combo", "grid"],
          description: "Bot type to validate",
        },
        payload: {
          type: "object",
          minProperties: 1,
          description:
            "Validation payload containing data.exchange, data.exchangeUUID, data.settings, and optional from/to/interval",
        },
        ...paperContextParam,
      },
      required: ["botType", "payload"],
    },
  },

  // ─── DISCOVERY ─────────────────────────────────────────────────────────

  {
    name: "get_discovery_bots",
    description:
      "List schema definitions for all bot types (dca, combo, grid), including sections and field metadata for bot creation and update payloads.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_discovery_bot",
    description:
      "Get the full schema definition for a single bot type, or a single section when 'section' is provided.",
    inputSchema: {
      type: "object",
      properties: {
        botType: {
          type: "string",
          enum: ["dca", "combo", "grid"],
          description: "Bot type",
        },
        section: {
          type: "string",
          description: 'Optional section id, e.g. "take_profit"',
        },
      },
      required: ["botType"],
    },
  },
  {
    name: "get_discovery_bot_sections",
    description:
      "List lightweight section summaries for a bot type, including id, name, description, and fieldCount.",
    inputSchema: {
      type: "object",
      properties: {
        botType: {
          type: "string",
          enum: ["dca", "combo", "grid"],
          description: "Bot type",
        },
      },
      required: ["botType"],
    },
  },
  {
    name: "get_discovery_indicators",
    description:
      "List supported indicator types with their supported actions and sections. Optionally filter by action or include exchange-specific supported intervals.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description:
            'Optional action filter, e.g. "startDeal", "closeDeal", or "stopBot"',
        },
        exchange: {
          type: "string",
          description:
            'Optional exchange filter to include supportedIntervals, e.g. "binance"',
        },
      },
    },
  },
  {
    name: "get_discovery_indicator",
    description:
      "Get the full field definition for a single indicator type, including core fields, type-specific fields, example payload, and group rules.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: 'Indicator type, e.g. "RSI"',
        },
        exchange: {
          type: "string",
          description:
            'Optional exchange to filter indicatorInterval values, e.g. "binance"',
        },
      },
      required: ["type"],
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
      not: {
        required: ["asset", "assets"],
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
      anyOf: [
        { required: ["name"] },
        { required: ["type"] },
        { required: ["value"] },
      ],
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
  validateToolArgs(name, args);

  switch (name) {
    // ── Bot Listing ──────────────────────────────────────────────────────

    case "get_dca_bots": {
      const res = await client.request("GET", "/api/v2/bots/dca", {
        query: {
          fields: args.fields,
          page: args.page,
          status: args.status,
        },
        headers: paperHeader(args),
      });
      return JSON.stringify(res, null, 2);
    }

    case "get_combo_bots": {
      const res = await client.request("GET", "/api/v2/bots/combo", {
        query: {
          fields: args.fields,
          page: args.page,
          status: args.status,
        },
        headers: paperHeader(args),
      });
      return JSON.stringify(res, null, 2);
    }

    case "get_grid_bots": {
      const res = await client.request("GET", "/api/v2/bots/grid", {
        query: {
          fields: args.fields,
          page: args.page,
          status: args.status,
        },
        headers: paperHeader(args),
      });
      return JSON.stringify(res, null, 2);
    }

    // ── Bot Creation ─────────────────────────────────────────────────────

    case "create_dca_bot": {
      const { settings = {}, paperContext, ...topLevel } = args;
      const body = { ...settings, ...topLevel };
      delete body.settings;
      delete body.paperContext;
      const res = await client.request("POST", "/api/v2/bots/dca", {
        body,
        headers: paperHeader(args),
      });
      return JSON.stringify(res, null, 2);
    }

    case "create_combo_bot": {
      const { settings = {}, paperContext, ...topLevel } = args;
      const body = { ...settings, ...topLevel };
      delete body.settings;
      delete body.paperContext;
      const res = await client.request("POST", "/api/v2/bots/combo", {
        body,
        headers: paperHeader(args),
      });
      return JSON.stringify(res, null, 2);
    }

    case "create_grid_bot": {
      const { settings = {}, paperContext, ...topLevel } = args;
      const body = { ...settings, ...topLevel };
      delete body.settings;
      delete body.paperContext;
      const res = await client.request("POST", "/api/v2/bots/grid", {
        body,
        headers: paperHeader(args),
      });
      return JSON.stringify(res, null, 2);
    }

    // ── Bot Update ───────────────────────────────────────────────────────

    case "update_dca_bot": {
      const res = await client.request(
        "PUT",
        `/api/v2/bots/dca/${args.botId}`,
        {
          body: args.settings,
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    case "update_combo_bot": {
      const res = await client.request(
        "PUT",
        `/api/v2/bots/combo/${args.botId}`,
        {
          body: args.settings,
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    // ── Bot Clone ────────────────────────────────────────────────────────

    case "clone_dca_bot": {
      const res = await client.request(
        "POST",
        `/api/v2/bots/dca/${args.botId}/clone`,
        {
          body: args.overrides || {},
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    case "clone_combo_bot": {
      const res = await client.request(
        "POST",
        `/api/v2/bots/combo/${args.botId}/clone`,
        {
          body: args.overrides || {},
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    case "clone_grid_bot": {
      const res = await client.request(
        "POST",
        `/api/v2/bots/grid/${args.botId}/clone`,
        {
          body: args.overrides || {},
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    // ── Bot Lifecycle ────────────────────────────────────────────────────

    case "start_bot": {
      const res = await client.request(
        "POST",
        `/api/v2/bots/${args.botType}/${args.botId}/start`,
        {
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    case "stop_bot": {
      const res = await client.request(
        "POST",
        `/api/v2/bots/${args.botType}/${args.botId}/stop`,
        {
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    case "archive_bot": {
      const res = await client.request(
        "DELETE",
        `/api/v2/bots/${args.botType}/${args.botId}`,
        {
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    case "restore_bot": {
      const res = await client.request(
        "POST",
        `/api/v2/bots/${args.botType}/${args.botId}/restore`,
        {
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    case "change_bot_pairs": {
      const res = await client.request(
        "PUT",
        `/api/v2/bots/dca/${args.botId}/pairs`,
        {
          body: { pair: args.pair },
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    // ── Deals Listing ────────────────────────────────────────────────────

    case "get_dca_deals": {
      const res = await client.request("GET", "/api/v2/deals/dca", {
        query: {
          fields: args.fields,
          page: args.page,
          status: args.status,
          botId: args.botId,
        },
        headers: paperHeader(args),
      });
      return JSON.stringify(res, null, 2);
    }

    case "get_combo_deals": {
      const res = await client.request("GET", "/api/v2/deals/combo", {
        query: {
          fields: args.fields,
          page: args.page,
          status: args.status,
          botId: args.botId,
        },
        headers: paperHeader(args),
      });
      return JSON.stringify(res, null, 2);
    }

    case "get_terminal_deals": {
      const res = await client.request("GET", "/api/v2/deals/terminal", {
        query: {
          fields: args.fields,
          page: args.page,
          status: args.status,
          botId: args.botId,
        },
        headers: paperHeader(args),
      });
      return JSON.stringify(res, null, 2);
    }

    // ── Deal Creation & Management ───────────────────────────────────────

    case "create_terminal_deal": {
      const { settings = {}, paperContext, ...topLevel } = args;
      const body = { ...settings, ...topLevel };
      delete body.settings;
      delete body.paperContext;
      const res = await client.request("POST", "/api/v2/deals/terminal", {
        body,
        headers: paperHeader(args),
      });
      return JSON.stringify(res, null, 2);
    }

    case "update_dca_deal": {
      const res = await client.request(
        "PUT",
        `/api/v2/deals/dca/${args.dealId}`,
        {
          body: args.settings,
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    case "update_combo_deal": {
      const res = await client.request(
        "PUT",
        `/api/v2/deals/combo/${args.dealId}`,
        {
          body: args.settings,
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    case "update_terminal_deal": {
      const res = await client.request(
        "PUT",
        `/api/v2/deals/terminal/${args.dealId}`,
        {
          body: args.settings,
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    case "start_deal": {
      const query: Record<string, any> = {};
      if (args.symbol) query.symbol = args.symbol;
      const res = await client.request(
        "POST",
        `/api/v2/deals/${args.botType}/${args.botId}/start`,
        {
          query,
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    case "close_deal": {
      const res = await client.request(
        "DELETE",
        `/api/v2/deals/${args.dealType}/${args.dealId}`,
        {
          query: { type: args.type },
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    case "add_funds": {
      const body: Record<string, any> = {
        qty: args.qty,
      };
      if (args.type) body.type = args.type;
      if (args.asset) body.asset = args.asset;
      if (args.symbol) body.symbol = args.symbol;
      const res = await client.request(
        "POST",
        "/api/v2/deals/dca/add-funds",
        {
          query: {
            dealId: args.dealId,
            botId: args.botId,
          },
          body,
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    case "reduce_funds": {
      const body: Record<string, any> = {
        qty: args.qty,
      };
      if (args.type) body.type = args.type;
      if (args.asset) body.asset = args.asset;
      if (args.symbol) body.symbol = args.symbol;
      const res = await client.request(
        "POST",
        "/api/v2/deals/dca/reduce-funds",
        {
          query: {
            dealId: args.dealId,
            botId: args.botId,
          },
          body,
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    case "add_funds_terminal": {
      const body: Record<string, any> = {
        qty: args.qty,
      };
      if (args.type) body.type = args.type;
      if (args.asset) body.asset = args.asset;
      if (args.symbol) body.symbol = args.symbol;
      const res = await client.request(
        "POST",
        `/api/v2/deals/terminal/${args.dealId}/add-funds`,
        { body }
      );
      return JSON.stringify(res, null, 2);
    }

    case "reduce_funds_terminal": {
      const body: Record<string, any> = {
        qty: args.qty,
      };
      if (args.type) body.type = args.type;
      if (args.asset) body.asset = args.asset;
      if (args.symbol) body.symbol = args.symbol;
      const res = await client.request(
        "POST",
        `/api/v2/deals/terminal/${args.dealId}/reduce-funds`,
        { body }
      );
      return JSON.stringify(res, null, 2);
    }

    // ── Backtest ─────────────────────────────────────────────────────────

    case "estimate_backtest_cost": {
      const res = await client.request(
        "POST",
        `/api/v2/backtest/${args.botType}/estimate-cost`,
        {
          body: { payload: args.payload },
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    case "request_backtest": {
      const res = await client.request(
        "POST",
        `/api/v2/backtest/${args.botType}/request`,
        {
          body: { payload: args.payload },
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    case "request_backtest_sync": {
      const res = await client.request(
        "POST",
        `/api/v2/backtest/${args.botType}/request/sync`,
        {
          query: { fields: args.fields },
          body: { payload: args.payload },
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    case "get_backtest_requests": {
      const res = await client.request(
        "GET",
        `/api/v2/backtest/${args.botType}/requests`,
        {
          query: {
            fields: args.fields,
            page: args.page,
          },
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    case "get_backtest_request": {
      const res = await client.request(
        "GET",
        `/api/v2/backtest/${args.botType}/requests/${args.id}`,
        {
          query: { fields: args.fields },
        }
      );
      return JSON.stringify(res, null, 2);
    }

    case "validate_backtest_payload": {
      const res = await client.request(
        "POST",
        `/api/v2/backtest/${args.botType}/validate`,
        {
          body: { payload: args.payload },
          headers: paperHeader(args),
        }
      );
      return JSON.stringify(res, null, 2);
    }

    // ── Discovery ────────────────────────────────────────────────────────

    case "get_discovery_bots": {
      const res = await client.request("GET", "/api/v2/discovery/bots");
      return JSON.stringify(res, null, 2);
    }

    case "get_discovery_bot": {
      const res = await client.request(
        "GET",
        `/api/v2/discovery/bots/${args.botType}`,
        {
          query: { section: args.section },
        }
      );
      return JSON.stringify(res, null, 2);
    }

    case "get_discovery_bot_sections": {
      const res = await client.request(
        "GET",
        `/api/v2/discovery/bots/${args.botType}/sections`
      );
      return JSON.stringify(res, null, 2);
    }

    case "get_discovery_indicators": {
      const res = await client.request("GET", "/api/v2/discovery/indicators", {
        query: {
          action: args.action,
          exchange: args.exchange,
        },
      });
      return JSON.stringify(res, null, 2);
    }

    case "get_discovery_indicator": {
      const res = await client.request(
        "GET",
        `/api/v2/discovery/indicators/${encodeURIComponent(args.type)}`,
        {
          query: { exchange: args.exchange },
        }
      );
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
        },
        headers: paperHeader(args),
      });
      return JSON.stringify(res, null, 2);
    }

    case "get_user_exchanges": {
      const res = await client.request("GET", "/api/v2/user/exchanges", {
        headers: paperHeader(args),
      });
      return JSON.stringify(res, null, 2);
    }

    case "get_global_variables": {
      const res = await client.request("GET", "/api/v2/user/global-vars", {
        query: { page: args.page },
      });
      return JSON.stringify(res, null, 2);
    }

    case "create_global_variable": {
      const res = await client.request("POST", "/api/v2/user/global-vars", {
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
        `/api/v2/user/global-vars/${args.id}`,
        { body }
      );
      return JSON.stringify(res, null, 2);
    }

    case "delete_global_variable": {
      const res = await client.request(
        "DELETE",
        `/api/v2/user/global-vars/${args.id}`
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
  { name: "gainium-mcp", version: "2.1.0" },
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
  console.error("[gainium-mcp] Server started (v2.1.0)");
}

main().catch((err) => {
  console.error("[gainium-mcp] Fatal error:", err);
  process.exit(1);
});
