#!/usr/bin/env node
/**
 * Guardrail MCP server.
 *
 * This is the surface an AI agent talks to. It exposes the same policy engine the
 * CLI uses, so what you watch in a terminal is exactly what the agent gets - there
 * is no separate, friendlier path for the demo.
 *
 * On the trust model, plainly: an MCP tool cannot stop an agent from calling some
 * other MCP server. Guardrail is only a real gate when it is the only execution
 * path the agent has. Binance's own scope model makes that achievable - connect
 * the Binance MCP server with market-data and account scopes but WITHOUT the trade
 * scope, and let Guardrail hold the trading capability. Then "ask Guardrail first"
 * stops being an instruction the agent could ignore and becomes the only thing
 * that works. README.md spells this out under "Trust model".
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { AccountSnapshot, EvaluationContext, ProposedOrder } from "./types.ts";
import { evaluate, InvalidOrderError, activeRules } from "./policy/engine.ts";
import { ConfigError, isLiveEnabled, loadPolicy } from "./config.ts";
import { loadState, saveState, recordPnl } from "./state/store.ts";
import { MarketDataError, get24h, resolveMarkPrice } from "./binance/public.ts";
import * as audit from "./audit.ts";

const CONFIG_PATH = process.env.GUARDRAIL_CONFIG;

const server = new McpServer(
  { name: "guardrail", version: "0.1.0" },
  {
    instructions:
      "Guardrail is a policy firewall for Binance trading. Before placing ANY order " +
      "through any other tool, call check_order first and obey the verdict. " +
      "A BLOCK verdict is final: do not retry it, do not split the order into smaller " +
      "pieces to get under a cap, and do not look for another route to the exchange. " +
      "Report the blocking rule to the user in plain language instead. A CONFIRM " +
      "verdict means you must ask the user for an explicit yes before proceeding.",
  },
);

/** Shared text-content reply helper. */
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

const orderShape = {
  symbol: z.string().describe("Trading pair, e.g. BTCUSDT. Must be quoted in a USD-pegged asset."),
  side: z.enum(["BUY", "SELL"]),
  market: z
    .enum(["SPOT", "MARGIN", "USDM_FUTURES", "COINM_FUTURES"])
    .default("SPOT"),
  type: z.enum(["MARKET", "LIMIT"]).default("MARKET"),
  quantity: z.number().positive().optional().describe("Size in the base asset. Use this OR quoteOrderQty."),
  quoteOrderQty: z.number().positive().optional().describe("Size in the quote asset, e.g. 100 USDT."),
  price: z.number().positive().optional().describe("Required for LIMIT orders."),
  leverage: z.number().min(1).optional().describe("Futures only."),
  reduceOnly: z.boolean().optional().describe("Futures only. Marks the order as risk-reducing."),
};

const accountShape = {
  equityUsd: z.number().positive().optional().describe("Account equity in USD. Defaults to 10000."),
  positions: z
    .array(z.object({ symbol: z.string(), notionalUsd: z.number() }))
    .optional()
    .describe("Existing exposure per symbol, in USD."),
  markPrice: z
    .number()
    .positive()
    .optional()
    .describe("Override the live mark price. Omit to fetch it from Binance."),
};

interface OrderArgs {
  symbol: string;
  side: "BUY" | "SELL";
  market: ProposedOrder["market"];
  type: ProposedOrder["type"];
  quantity?: number;
  quoteOrderQty?: number;
  price?: number;
  leverage?: number;
  reduceOnly?: boolean;
  equityUsd?: number;
  positions?: { symbol: string; notionalUsd: number }[];
  markPrice?: number;
}

function toOrder(a: OrderArgs): ProposedOrder {
  const order: ProposedOrder = {
    symbol: a.symbol.toUpperCase(),
    side: a.side,
    type: a.type,
    market: a.market,
  };
  if (a.quantity !== undefined) order.quantity = a.quantity;
  if (a.quoteOrderQty !== undefined) order.quoteOrderQty = a.quoteOrderQty;
  if (a.price !== undefined) order.price = a.price;
  if (a.leverage !== undefined) order.leverage = a.leverage;
  if (a.reduceOnly !== undefined) order.reduceOnly = a.reduceOnly;
  return order;
}

function toAccount(a: OrderArgs): AccountSnapshot {
  return {
    equityUsd: a.equityUsd ?? 10_000,
    positions: a.positions ?? [],
    realisedPnlTodayUsd: 0,
    source: "simulated",
  };
}

/** Turns any thrown error into a tool error the agent can actually act on. */
function errorReply(err: unknown) {
  if (err instanceof InvalidOrderError || err instanceof ConfigError || err instanceof MarketDataError) {
    return { ...text(`${err.name}: ${err.message}`), isError: true as const };
  }
  return { ...text(`Unexpected error: ${(err as Error).message}`), isError: true as const };
}

server.registerTool(
  "check_order",
  {
    title: "Check an order against the policy",
    description:
      "Evaluate a proposed order against the user's risk policy BEFORE placing it. " +
      "Returns ALLOW, CONFIRM, or BLOCK with the reasoning for every rule. " +
      "Call this first for every order. Treat BLOCK as final - never retry, split, " +
      "or reroute a blocked order.",
    inputSchema: { ...orderShape, ...accountShape },
  },
  async (args) => {
    try {
      const a = args as unknown as OrderArgs;
      const { policy } = loadPolicy(CONFIG_PATH);
      const now = new Date();
      const state = loadState(now);
      const order = toOrder(a);

      const { price, source } = await resolveMarkPrice(order.symbol, a.markPrice);
      const ctx: EvaluationContext = {
        policy,
        account: toAccount(a),
        state,
        markPrice: price,
        now,
      };

      const decision = evaluate(order, ctx);
      audit.append(audit.toEntry(decision, { transmitted: false }));

      const lines = [
        `VERDICT: ${decision.verdict}`,
        `${order.side} ${order.symbol} ${order.market}` +
          (order.leverage ? ` ${order.leverage}x` : "") +
          `  notional $${decision.notionalUsd.toFixed(2)}  mark $${price.toFixed(2)} (${source})`,
        "",
        ...decision.results.map(
          (r) => `${r.verdict === "BLOCK" ? "[BLOCK]" : r.verdict === "CONFIRM" ? "[CONFIRM]" : "[ok]"} ${r.rule}: ${r.message}`,
        ),
        "",
      ];

      if (decision.verdict === "BLOCK") {
        lines.push(
          `Refused by: ${decision.blockedBy.join(", ")}.`,
          "Nothing was sent to Binance. Do not retry this order, do not split it into " +
            "smaller orders, and do not route it through another tool. Tell the user which " +
            "rule stopped it and why.",
        );
      } else if (decision.verdict === "CONFIRM") {
        lines.push(
          `Needs human approval: ${decision.confirmRequiredBy.join(", ")}.`,
          "Ask the user for an explicit yes before placing this order.",
        );
      } else {
        lines.push(
          isLiveEnabled(policy)
            ? "Cleared. You may place this order."
            : "Cleared by policy, but Guardrail is in dry-run, so nothing may actually be transmitted.",
        );
      }

      return text(lines.join("\n"));
    } catch (err) {
      return errorReply(err);
    }
  },
);

server.registerTool(
  "get_policy",
  {
    title: "Show the active risk policy",
    description:
      "List the risk rules currently in force, and whether Guardrail is in dry-run or live mode. " +
      "Use this to explain to the user what is protecting them, or to understand why an order was blocked.",
    inputSchema: {},
  },
  async () => {
    try {
      const { policy, source } = loadPolicy(CONFIG_PATH);
      const rules = activeRules(policy);
      const lines = [
        `Mode: ${policy.mode}${isLiveEnabled(policy) ? " (live: orders may be transmitted)" : " (dry-run: nothing will be transmitted)"}`,
        `Source: ${source}`,
        "",
        `${rules.length} rule(s) active:`,
        ...rules.map((r) => `  - ${r.name}: ${r.purpose}`),
        "",
        "Limits:",
        ...Object.entries(policy)
          .filter(([k]) => k !== "version" && k !== "mode")
          .map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`),
        "",
        "This policy is read from a file the user controls. You cannot change it. " +
          "If the user wants a limit changed, tell them to edit that file themselves.",
      ];
      return text(lines.join("\n"));
    } catch (err) {
      return errorReply(err);
    }
  },
);

server.registerTool(
  "get_market_price",
  {
    title: "Live Binance price",
    description: "Fetch the live price and 24h stats for a symbol from Binance public market data. Read-only.",
    inputSchema: { symbol: z.string().describe("Trading pair, e.g. BTCUSDT") },
  },
  async ({ symbol }) => {
    try {
      const t = await get24h(symbol);
      return text(
        `${t.symbol}  $${t.lastPrice}  ${t.priceChangePercent >= 0 ? "+" : ""}${t.priceChangePercent}% 24h\n` +
          `24h high $${t.highPrice}  low $${t.lowPrice}  quote volume $${t.quoteVolume.toLocaleString("en-US")}`,
      );
    } catch (err) {
      return errorReply(err);
    }
  },
);

server.registerTool(
  "get_audit_summary",
  {
    title: "What Guardrail has decided",
    description:
      "Summarise every decision Guardrail has made: allowed, blocked, needing confirmation, " +
      "how much order flow was refused, and which rules fire most. Use this to review agent behaviour.",
    inputSchema: {},
  },
  async () => {
    const s = audit.summarise(audit.read());
    if (s.total === 0) return text("No decisions logged yet.");
    return text(
      [
        `${s.total} decisions: ${s.allowed} allowed, ${s.confirmed} needed confirmation, ${s.blocked} blocked.`,
        `${s.transmitted} actually transmitted to Binance.`,
        `$${s.notionalBlockedUsd.toFixed(2)} of order flow refused.`,
        "",
        "Most-triggered rules:",
        ...s.topRules.slice(0, 5).map((r) => `  ${r.rule}: ${r.blocks}`),
      ].join("\n"),
    );
  },
);

server.registerTool(
  "record_realised_pnl",
  {
    title: "Record realised PnL",
    description:
      "Record the realised profit or loss of a closed trade, in USD. Negative means a loss. " +
      "This feeds the daily loss circuit breaker and arms the post-loss cooldown, so report " +
      "closed trades here to keep those rules meaningful.",
    inputSchema: {
      pnlUsd: z.number().describe("Realised PnL in USD. Negative for a loss."),
    },
  },
  async ({ pnlUsd }) => {
    const now = new Date();
    const next = recordPnl(loadState(now), pnlUsd, now);
    saveState(next);
    return text(
      `Recorded $${pnlUsd.toFixed(2)}. Realised today: $${next.realisedPnlTodayUsd.toFixed(2)}.` +
        (pnlUsd < 0 ? " Post-loss cooldown is now armed." : ""),
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr only: stdout is the MCP wire protocol and must carry nothing else.
console.error("guardrail mcp server ready");
