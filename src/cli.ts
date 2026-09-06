#!/usr/bin/env node
/**
 * Guardrail CLI.
 *
 * Mirrors exactly what the MCP server does, so anything you can watch here is
 * what an agent gets. That symmetry is deliberate: the demo is not a mock-up of
 * the enforcement path, it is the enforcement path.
 */

import type {
  AccountSnapshot,
  Decision,
  EvaluationContext,
  Market,
  ProposedOrder,
  Side,
} from "./types.ts";
import { evaluate, InvalidOrderError } from "./policy/engine.ts";
import { ALL_RULES } from "./policy/rules.ts";
import { ConfigError, isLiveEnabled, loadPolicy } from "./config.ts";
import { loadState, saveState, recordPnl } from "./state/store.ts";
import { MarketDataError, resolveMarkPrice, get24h } from "./binance/public.ts";
import * as audit from "./audit.ts";

const useColor =
  process.env.NO_COLOR === undefined && process.stdout.isTTY === true;

const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
  inverse: (s: string) => (useColor ? `\x1b[7m${s}\x1b[0m` : s),
};

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out.set(a.slice(2, eq), a.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.set(a.slice(2), next);
        i++;
      } else {
        out.set(a.slice(2), "true");
      }
    }
  }
  return out;
}

function requireNum(args: Map<string, string>, key: string): number | undefined {
  const raw = args.get(key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new InvalidOrderError(`--${key} must be a number, got "${raw}".`);
  }
  return n;
}

/**
 * Build the account snapshot.
 *
 * Guardrail does not hold exchange credentials, so equity and open positions are
 * supplied by the caller. They are labelled `simulated` throughout and every
 * printout says so - a risk number whose provenance is unclear is worse than no
 * number at all.
 */
function buildAccount(args: Map<string, string>): AccountSnapshot {
  const equityUsd = requireNum(args, "equity") ?? 10_000;
  const positions: AccountSnapshot["positions"] = [];
  const raw = args.get("position");
  if (raw) {
    for (const part of raw.split(",")) {
      const [symbol, amount] = part.split(":");
      if (!symbol || amount === undefined) {
        throw new InvalidOrderError(`--position expects SYMBOL:USD pairs, got "${part}".`);
      }
      const n = Number(amount);
      if (!Number.isFinite(n)) {
        throw new InvalidOrderError(`--position amount for ${symbol} is not a number.`);
      }
      positions.push({ symbol: symbol.toUpperCase(), notionalUsd: n });
    }
  }
  return {
    equityUsd,
    positions,
    realisedPnlTodayUsd: requireNum(args, "pnl") ?? 0,
    source: "simulated",
  };
}

function buildOrder(args: Map<string, string>): ProposedOrder {
  const symbol = (args.get("symbol") ?? "").toUpperCase();
  const side = (args.get("side") ?? "BUY").toUpperCase() as Side;
  const market = (args.get("market") ?? "SPOT").toUpperCase() as Market;
  const type = (args.get("type") ?? "MARKET").toUpperCase() as ProposedOrder["type"];

  if (side !== "BUY" && side !== "SELL") {
    throw new InvalidOrderError(`--side must be BUY or SELL, got "${side}".`);
  }

  const order: ProposedOrder = { symbol, side, type, market };
  const qty = requireNum(args, "qty");
  const quote = requireNum(args, "quote");
  const price = requireNum(args, "price-limit");
  const leverage = requireNum(args, "leverage");

  if (qty !== undefined) order.quantity = qty;
  if (quote !== undefined) order.quoteOrderQty = quote;
  if (price !== undefined) order.price = price;
  if (leverage !== undefined) order.leverage = leverage;
  if (args.get("reduce-only") === "true") order.reduceOnly = true;

  return order;
}

function verdictBadge(v: Decision["verdict"]): string {
  if (v === "ALLOW") return c.green(c.inverse(" ALLOWED "));
  if (v === "CONFIRM") return c.yellow(c.inverse(" NEEDS CONFIRMATION "));
  return c.red(c.inverse(" BLOCKED "));
}

function printDecision(decision: Decision, opts: { priceSource: string; mode: string }): void {
  const o = decision.order;
  const size =
    o.quantity !== undefined
      ? `${o.quantity} ${o.symbol.replace(/USDT|USDC|FDUSD|TUSD|BUSD|USD$/, "")}`
      : money(o.quoteOrderQty ?? 0);
  const lev = o.leverage !== undefined ? `  ${c.bold(`${o.leverage}x`)}` : "";
  const reduce = o.reduceOnly ? c.dim("  reduce-only") : "";

  console.log();
  console.log(
    `  ${c.bold("GUARDRAIL")}  ${c.dim(opts.mode)}`,
  );
  console.log();
  console.log(`  ${c.bold(o.side)} ${size}  ${c.dim("·")}  ${o.symbol}  ${c.dim("·")}  ${o.market}${lev}${reduce}`);
  console.log(
    c.dim(
      `  mark ${money(decision.markPrice)} (${opts.priceSource})  →  notional ${money(decision.notionalUsd)}`,
    ),
  );
  console.log();

  const width = Math.max(...decision.results.map((r) => r.rule.length), 10);
  for (const r of decision.results) {
    const mark =
      r.verdict === "BLOCK" ? c.red("✗") : r.verdict === "CONFIRM" ? c.yellow("!") : c.green("✓");
    const name = r.rule.padEnd(width);
    const label = r.verdict === "ALLOW" ? c.dim(name) : c.bold(name);
    const msg = r.verdict === "ALLOW" ? c.dim(r.message) : r.message;
    console.log(`  ${mark} ${label}  ${msg}`);
  }

  console.log();
  console.log(`  ${verdictBadge(decision.verdict)}`);

  if (decision.verdict === "BLOCK") {
    console.log(
      c.dim(`  Refused by ${decision.blockedBy.length} rule(s). Nothing was sent to Binance.`),
    );
  } else if (decision.verdict === "CONFIRM") {
    console.log(c.dim("  Passes every rule, but needs a human yes before it can be sent."));
  } else if (opts.mode.startsWith("dry-run")) {
    console.log(c.dim("  Would be sent. Dry-run is on, so nothing left this machine."));
  } else {
    console.log(c.dim("  Cleared for transmission."));
  }
  console.log();
}

async function cmdCheck(args: Map<string, string>): Promise<number> {
  const { policy, source } = loadPolicy(args.get("config"));
  const now = new Date();
  const state = loadState(now);
  const order = buildOrder(args);
  const account = buildAccount(args);

  if (!order.symbol) {
    console.error(c.red("  --symbol is required, e.g. --symbol BTCUSDT"));
    return 2;
  }

  const { price, source: priceSource } = await resolveMarkPrice(
    order.symbol,
    requireNum(args, "price"),
  );

  const ctx: EvaluationContext = {
    policy,
    account,
    state: { ...state, realisedPnlTodayUsd: account.realisedPnlTodayUsd || state.realisedPnlTodayUsd },
    markPrice: price,
    now,
  };

  const decision = evaluate(order, ctx);
  const live = isLiveEnabled(policy);
  const mode = live ? "LIVE" : `dry-run  ${c.dim("·")}  ${source}`;

  if (args.get("json") === "true") {
    console.log(JSON.stringify(audit.toEntry(decision, { transmitted: false }), null, 2));
  } else {
    printDecision(decision, { priceSource, mode });
  }

  audit.append(audit.toEntry(decision, { transmitted: false }));
  return decision.verdict === "BLOCK" ? 1 : 0;
}

function cmdPolicy(args: Map<string, string>): number {
  const { policy, source } = loadPolicy(args.get("config"));

  console.log();
  console.log(`  ${c.bold("GUARDRAIL POLICY")}`);
  console.log(c.dim(`  ${source}`));
  console.log(
    c.dim(
      `  mode: ${policy.mode}${isLiveEnabled(policy) ? "" : "  (nothing will be transmitted)"}`,
    ),
  );
  console.log();

  const width = Math.max(...ALL_RULES.map((r) => r.name.length));
  let active = 0;
  for (const rule of ALL_RULES) {
    const on = rule.isConfigured(policy);
    if (on) active++;
    const mark = on ? c.green("●") : c.dim("○");
    const name = rule.name.padEnd(width);
    console.log(
      on
        ? `  ${mark} ${name}  ${c.dim(rule.purpose)}`
        : `  ${mark} ${c.dim(name)}  ${c.dim("not configured")}`,
    );
  }

  console.log();
  console.log(c.dim(`  ${active} of ${ALL_RULES.length} rules active.`));
  console.log();
  return 0;
}

function cmdLog(args: Map<string, string>): number {
  const entries = audit.read();
  if (entries.length === 0) {
    console.log(c.dim("\n  No decisions logged yet. Run `guardrail check` first.\n"));
    return 0;
  }
  const s = audit.summarise(entries);

  if (args.get("json") === "true") {
    console.log(JSON.stringify(s, null, 2));
    return 0;
  }

  console.log();
  console.log(`  ${c.bold("AUDIT LOG")}  ${c.dim(`${s.total} decisions`)}`);
  console.log();
  console.log(`  ${c.green("allowed")}      ${s.allowed}`);
  console.log(`  ${c.yellow("confirm")}      ${s.confirmed}`);
  console.log(`  ${c.red("blocked")}      ${s.blocked}`);
  console.log(`  transmitted  ${s.transmitted}`);
  console.log();
  console.log(`  ${c.bold(money(s.notionalBlockedUsd))} of order flow refused.`);

  if (s.topRules.length > 0) {
    console.log();
    console.log(c.dim("  most-triggered rules"));
    for (const r of s.topRules.slice(0, 5)) {
      console.log(`    ${r.rule.padEnd(28)} ${c.red(String(r.blocks))}`);
    }
  }
  console.log();
  return 0;
}

async function cmdPrice(args: Map<string, string>): Promise<number> {
  const symbol = (args.get("symbol") ?? "BTCUSDT").toUpperCase();
  const t = await get24h(symbol);
  const arrow = t.priceChangePercent >= 0 ? c.green("▲") : c.red("▼");
  console.log();
  console.log(`  ${c.bold(t.symbol)}  ${money(t.lastPrice)}  ${arrow} ${t.priceChangePercent.toFixed(2)}%`);
  console.log(c.dim(`  24h high ${money(t.highPrice)}   low ${money(t.lowPrice)}`));
  console.log();
  return 0;
}

/** Marks a realised loss so the cooldown rule has something to bite on. */
function cmdRecordLoss(args: Map<string, string>): number {
  const amount = requireNum(args, "usd");
  if (amount === undefined) {
    console.error(c.red("  --usd is required, e.g. --usd -120"));
    return 2;
  }
  const now = new Date();
  const next = recordPnl(loadState(now), amount, now);
  saveState(next);
  console.log(
    `\n  Recorded ${amount < 0 ? c.red(money(amount)) : c.green(money(amount))}. ` +
      `Today: ${money(next.realisedPnlTodayUsd)}.\n`,
  );
  return 0;
}

function cmdReset(): number {
  const now = new Date();
  saveState({
    day: now.toISOString().slice(0, 10),
    notionalTodayUsd: 0,
    ordersToday: 0,
    recentOrderTimes: [],
    lastLossAt: null,
    realisedPnlTodayUsd: 0,
  });
  console.log(c.dim("\n  State reset. Audit log kept.\n"));
  return 0;
}

const HELP = `
  ${c.bold("guardrail")} - a policy firewall for Binance Agent OS

  ${c.bold("COMMANDS")}
    check          Evaluate a proposed order against your policy
    policy         Show which rules are active
    log            Summarise the audit log
    price          Live 24h stats for a symbol
    record-loss    Record realised PnL (arms the cooldown rule)
    reset          Clear rolling state

  ${c.bold("CHECK OPTIONS")}
    --symbol       Trading pair, e.g. BTCUSDT            ${c.dim("(required)")}
    --side         BUY or SELL                           ${c.dim("(default BUY)")}
    --market       SPOT | MARGIN | USDM_FUTURES | COINM_FUTURES
    --type         MARKET or LIMIT                       ${c.dim("(default MARKET)")}
    --qty          Size in the base asset, e.g. 0.5
    --quote        Size in the quote asset, e.g. 100
    --leverage     Futures leverage
    --reduce-only  Mark as risk-reducing
    --price        Override the mark price               ${c.dim("(skips the network)")}
    --equity       Simulated account equity              ${c.dim("(default 10000)")}
    --position     Existing exposure, e.g. BTCUSDT:4000
    --pnl          Realised PnL today, e.g. -180
    --json         Machine-readable output

  ${c.bold("EXAMPLES")}
    guardrail check --symbol BTCUSDT --side BUY --quote 40
    guardrail check --symbol BTCUSDT --market USDM_FUTURES --qty 3 --leverage 20
    guardrail policy
    guardrail log
`;

async function main(): Promise<number> {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);

  try {
    switch (cmd) {
      case "check": return await cmdCheck(args);
      case "policy": return cmdPolicy(args);
      case "log": return cmdLog(args);
      case "price": return await cmdPrice(args);
      case "record-loss": return cmdRecordLoss(args);
      case "reset": return cmdReset();
      case undefined:
      case "help":
      case "--help":
      case "-h": console.log(HELP); return 0;
      default:
        console.error(c.red(`\n  Unknown command "${cmd}".`));
        console.log(HELP);
        return 2;
    }
  } catch (err) {
    if (err instanceof InvalidOrderError || err instanceof ConfigError) {
      console.error(`\n  ${c.red("✗")} ${err.message}\n`);
      return 2;
    }
    if (err instanceof MarketDataError) {
      console.error(`\n  ${c.red("✗")} ${err.message}\n`);
      return 3;
    }
    throw err;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
