#!/usr/bin/env node
/**
 * Crucible CLI.
 *
 * The same calls the MCP server makes, in a form a person can read. There is no
 * separate presentation path: what is printed here is what an agent is told, so
 * a demo cannot show something the product does not actually do.
 */

import { takeSnapshot } from "./snapshot.ts";
import { priceAllRoutes } from "./cost/model.ts";
import { measuredImpactBps, route, RouteError } from "./decide/router.ts";
import { ConfigError, DEFAULT_POLICY, isLiveEnabled, loadPolicy } from "./config.ts";
import { BinanceError } from "./venues/binance.ts";
import { OnchainError } from "./venues/onchain.ts";
import { SnapshotError } from "./snapshot.ts";
import { isSample, readSamples, sampleSweep } from "./sampler/run.ts";
import { verifyLedger } from "./ledger/verify.ts";
import { credentialsFromEnv, DEMO, MAINNET } from "./exec/binance-rest.ts";
import { walletStatus, walletVersion } from "./exec/wallet.ts";
import { summarise } from "./sampler/analyse.ts";
import { ALL_RULES } from "./risk/rules.ts";
import { evaluate } from "./risk/engine.ts";
import type { CostEstimate, Plan, Policy, Side, Snapshot } from "./types.ts";

const colour = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;
const c = {
  dim: (s: string) => (colour ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (colour ? `\x1b[1m${s}\x1b[0m` : s),
  red: (s: string) => (colour ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s: string) => (colour ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (colour ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (colour ? `\x1b[36m${s}\x1b[0m` : s),
  inv: (s: string) => (colour ? `\x1b[7m${s}\x1b[0m` : s),
};

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const bps = (n: number) => `${n >= 0 ? "" : "-"}${Math.abs(n).toFixed(2)} bps`;
const venueName = (v: string) => (v === "ONCHAIN" ? "on-chain" : "Binance spot");

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out.set(a.slice(2), next);
      i++;
    } else {
      out.set(a.slice(2), "true");
    }
  }
  return out;
}

function numArg(args: Map<string, string>, key: string): number | undefined {
  const raw = args.get(key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new RouteError(`--${key} must be a number, got "${raw}".`);
  return n;
}

/** Resolve the size the caller asked for, in the base asset. */
async function resolveSnapshot(args: Map<string, string>): Promise<{
  snapshot: Snapshot;
  side: Side;
  baseQty: number;
  symbol: string;
}> {
  const symbol = (args.get("symbol") ?? "BNBUSDT").toUpperCase();
  const side = (args.get("side") ?? "BUY").toUpperCase() as Side;
  if (side !== "BUY" && side !== "SELL") {
    throw new RouteError(`--side must be BUY or SELL, got "${side}".`);
  }

  const usd = numArg(args, "usd");
  const qty = numArg(args, "qty");
  if ((usd === undefined) === (qty === undefined)) {
    throw new RouteError("Give exactly one of --usd (size in quote) or --qty (size in base).");
  }

  // A cheap Binance-only snapshot converts dollars into a base quantity, because
  // the on-chain quote has to be taken at the real size to mean anything.
  let baseQty = qty!;
  if (usd !== undefined) {
    const probe = await takeSnapshot({ symbol, side, baseQty: 1, skipOnchain: true });
    baseQty = usd / probe.mid;
  }

  const snapshot = await takeSnapshot({ symbol, side, baseQty });
  return { snapshot, side, baseQty, symbol };
}

function printRoute(r: CostEstimate, chosen: boolean, mid: number, quoteAssetPrecision: number): void {
  const label = `${venueName(r.venue)} ${r.style.toLowerCase()}`;
  if (r.unavailable) {
    console.log(`  ${c.dim("○")} ${c.dim(label.padEnd(26))} ${c.dim(r.unavailable)}`);
    return;
  }
  const mark = chosen ? c.green("●") : c.dim("○");
  const total = chosen ? c.bold(bps(r.totalBps).padStart(11)) : c.dim(bps(r.totalBps).padStart(11));
  const est = r.hasEstimates ? c.yellow(" ~") : "  ";
  console.log(
    `  ${mark} ${(chosen ? c.bold(label) : label).padEnd(chosen && colour ? 34 : 26)} ${total}${est}  ${c.dim(money(r.totalUsd))}`,
  );
  for (const comp of r.components) {
    console.log(
      `      ${c.dim(comp.name.padEnd(20))} ${c.dim(comp.bps.toFixed(3).padStart(9))}   ${c.dim(comp.detail)}`,
    );
  }
  console.log(`      ${c.dim("effective price".padEnd(20))} ${c.dim(r.effectivePrice.toFixed(quoteAssetPrecision).padStart(9))}`);
}

function printPlanHeader(snapshot: Snapshot, side: Side, baseQty: number): void {
  const notional = baseQty * snapshot.mid;
  console.log();
  console.log(
    `  ${c.bold("CRUCIBLE")}  ${c.dim(`${snapshot.symbol}  snapshot ${snapshot.hash}`)}`,
  );
  console.log(
    `  ${c.bold(side)} ${baseQty.toFixed(6)} ${snapshot.filters.baseAsset}  ${c.dim("·")}  ${c.dim(money(notional))}`,
  );
  console.log(
    c.dim(
      `  mid ${snapshot.mid.toFixed(snapshot.filters.quoteAssetPrecision)}   spread ${snapshot.spreadBps.toFixed(2)} bps   ` +
        `flow ${(side === "BUY" ? snapshot.flow.hitsBidPerSec : snapshot.flow.liftsAskPerSec).toFixed(2)} ${snapshot.filters.baseAsset}/s over ${snapshot.flow.windowSec.toFixed(0)}s`,
    ),
  );
  if (snapshot.commission.source !== "account") {
    console.log(c.dim(`  fees: public VIP 0 schedule, not read from an account`));
  }
  if (snapshot.onchainUnavailable) {
    console.log(c.yellow(`  on-chain unavailable: ${snapshot.onchainUnavailable}`));
  }
  console.log();
}

async function cmdQuote(args: Map<string, string>): Promise<number> {
  const { snapshot, side, baseQty } = await resolveSnapshot(args);
  const routes = priceAllRoutes({ snapshot, side, baseQty });
  const usable = routes.filter((r) => !r.unavailable).sort((a, b) => a.totalBps - b.totalBps);
  const best = usable[0];

  if (args.get("json") === "true") {
    console.log(JSON.stringify({ snapshot: snapshot.hash, mid: snapshot.mid, routes }, null, 2));
    return 0;
  }

  printPlanHeader(snapshot, side, baseQty);
  for (const r of routes) printRoute(r, r === best, snapshot.mid, snapshot.filters.quoteAssetPrecision);
  console.log();
  if (usable.length > 1) {
    const gap = usable[1]!.totalBps - best!.totalBps;
    console.log(
      `  ${c.green("cheapest")}  ${c.bold(venueName(best!.venue))} by ${c.bold(bps(gap))} ` +
        c.dim(`= ${money((gap / 10_000) * baseQty * snapshot.mid)} on this order`),
    );
  }
  if (routes.some((r) => r.hasEstimates)) {
    console.log(c.dim(`  ${c.yellow("~")} marks a route with modelled components.`));
  }
  console.log();
  return 0;
}

function printPlan(plan: Plan, snapshot: Snapshot, side: Side): void {
  printPlanHeader(snapshot, side, plan.baseQty);
  printRoute(plan.chosen, true, snapshot.mid, snapshot.filters.quoteAssetPrecision);
  for (const alt of plan.alternatives) {
    printRoute(alt, false, snapshot.mid, snapshot.filters.quoteAssetPrecision);
  }
  console.log();
  console.log(`  ${c.bold("plan")} ${plan.id}   ${c.dim(`fingerprint ${plan.fingerprint}`)}`);
  console.log(`  ${c.dim(plan.rationale)}`);
  if (plan.savingBps > 0.01) {
    console.log(
      `  ${c.green("saves")} ${c.bold(bps(plan.savingBps))} ${c.dim(`= ${money(plan.savingUsd)} against the next best route`)}`,
    );
  }
  if (plan.slices.length > 0) {
    console.log(c.dim(`  ${plan.slices.length} children: ${plan.slices.map((s) => s.baseQty.toFixed(4)).join(", ")}`));
  }
  console.log(c.dim(`  expires in ${Math.round((plan.expiresAt - plan.createdAt) / 1000)}s`));
  console.log();
}

async function cmdRoute(args: Map<string, string>): Promise<number> {
  const { policy } = loadPolicy(args.get("config"));
  const { snapshot, side, baseQty, symbol } = await resolveSnapshot(args);

  const plan = route({
    intent: { symbol, side, baseQty },
    snapshot,
    policy,
  });

  // The risk engine sees the routed order, so venue-aware rules can act on it.
  const decision = evaluate(
    {
      symbol,
      side,
      type: "MARKET",
      market: "SPOT",
      quantity: baseQty,
      venue: plan.chosen.venue,
    },
    {
      policy,
      account: {
        equityUsd: numArg(args, "equity") ?? 100_000,
        positions: [],
        realisedPnlTodayUsd: 0,
        source: "simulated",
      },
      state: {
        day: new Date().toISOString().slice(0, 10),
        notionalTodayUsd: 0,
        ordersToday: 0,
        recentOrderTimes: [],
        lastLossAt: null,
        realisedPnlTodayUsd: 0,
      },
      markPrice: snapshot.mid,
      now: new Date(),
      snapshot,
      impactBps: measuredImpactBps(snapshot, side, baseQty),
    },
  );

  if (args.get("json") === "true") {
    console.log(JSON.stringify({ plan, risk: decision }, null, 2));
    return decision.verdict === "BLOCK" ? 1 : 0;
  }

  printPlan(plan, snapshot, side);

  console.log(`  ${c.bold("risk")}`);
  for (const r of decision.results) {
    const mark =
      r.verdict === "BLOCK" ? c.red("✗") : r.verdict === "CONFIRM" ? c.yellow("!") : c.green("✓");
    const name = r.verdict === "ALLOW" ? c.dim(r.rule.padEnd(26)) : c.bold(r.rule.padEnd(26));
    const msg = r.verdict === "ALLOW" ? c.dim(r.message) : r.message;
    console.log(`   ${mark} ${name} ${msg}`);
  }
  console.log();

  const badge =
    decision.verdict === "BLOCK"
      ? c.red(c.inv(" BLOCKED "))
      : decision.verdict === "CONFIRM"
        ? c.yellow(c.inv(" NEEDS CONFIRMATION "))
        : c.green(c.inv(" CLEARED "));
  console.log(`  ${badge}`);

  if (decision.verdict === "BLOCK") {
    console.log(c.dim(`  Refused by ${decision.blockedBy.join(", ")}. Nothing was sent.`));
  } else if (!isLiveEnabled(policy)) {
    console.log(c.dim("  Dry run: this plan would be sent, but execution is not enabled."));
  }
  console.log();
  return decision.verdict === "BLOCK" ? 1 : 0;
}

function cmdPolicy(args: Map<string, string>): number {
  const { policy, source } = loadPolicy(args.get("config"));
  console.log();
  console.log(`  ${c.bold("CRUCIBLE POLICY")}`);
  console.log(c.dim(`  ${source}`));
  console.log(
    c.dim(`  mode: ${policy.mode}${isLiveEnabled(policy) ? "" : "  (nothing will be transmitted)"}`),
  );
  console.log();

  const width = Math.max(...ALL_RULES.map((r) => r.name.length));
  let active = 0;
  for (const rule of ALL_RULES) {
    const on = rule.isConfigured(policy);
    if (on) active++;
    console.log(
      on
        ? `  ${c.green("●")} ${rule.name.padEnd(width)}  ${c.dim(rule.purpose)}`
        : `  ${c.dim("○")} ${c.dim(rule.name.padEnd(width))}  ${c.dim("not configured")}`,
    );
  }
  console.log();
  console.log(c.dim(`  ${active} of ${ALL_RULES.length} rules active.`));
  console.log();
  return 0;
}

function cmdSamples(args: Map<string, string>): number {
  const rows = readSamples();
  const samples = rows.filter(isSample);
  if (samples.length === 0) {
    console.log(c.dim("\n  No samples yet. Run `crucible sample` or start the sampler.\n"));
    return 0;
  }
  const report = summarise(samples);
  if (args.get("json") === "true") {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  console.log();
  console.log(`  ${c.bold("EXECUTION EVIDENCE")}  ${c.dim(`${report.total} samples, ${report.failures} failed`)}`);
  console.log(c.dim(`  ${report.from} to ${report.to} (${report.spanHours.toFixed(1)} hours)`));
  console.log();
  console.log(`  ${c.dim("symbol      size".padEnd(24))}${c.dim("on-chain wins".padStart(15))}${c.dim("median edge".padStart(14))}`);
  for (const b of report.buckets) {
    const pct = `${(b.onchainWinRate * 100).toFixed(0)}%`;
    console.log(
      `  ${(b.symbol + "  " + money(b.notionalUsd)).padEnd(24)}${pct.padStart(15)}${bps(b.medianEdgeBps).padStart(14)}   ${c.dim(`n=${b.count}`)}`,
    );
  }
  console.log();
  console.log(`  ${c.bold(`On-chain was cheaper in ${(report.onchainWinRate * 100).toFixed(1)}% of ${report.total} samples.`)}`);
  console.log(c.dim(`  Median saving when it won: ${bps(report.medianEdgeBps)}.`));
  console.log();
  return 0;
}

/**
 * What can actually execute, right now.
 *
 * Reported before anything is promised. A router that quotes a venue it cannot
 * reach is worse than one that quotes nothing, so the missing pieces are named
 * plainly rather than left to fail at execution time.
 */
async function cmdStatus(args: Map<string, string>): Promise<number> {
  const { policy, source } = loadPolicy(args.get("config"));
  console.log();
  console.log(`  ${c.bold("CRUCIBLE STATUS")}`);
  console.log(c.dim(`  ${source}`));
  console.log();

  const baseUrl = process.env.CRUCIBLE_BINANCE_BASE ?? DEMO;
  let binanceLine: string;
  try {
    credentialsFromEnv();
    binanceLine =
      `${c.green("●")} Binance      credentials present, pointing at ${baseUrl}` +
      (baseUrl === MAINNET ? c.red("  (LIVE EXCHANGE)") : c.dim("  (practice)"));
  } catch {
    binanceLine = `${c.yellow("○")} Binance      ${c.dim("no credentials — quoting works, the exchange leg cannot execute")}`;
  }
  console.log(`  ${binanceLine}`);

  const version = await walletVersion();
  if (!version) {
    console.log(
      `  ${c.yellow("○")} Wallet       ${c.dim("CLI not installed — quoting works, the on-chain leg cannot execute")}`,
    );
  } else {
    try {
      const session = await walletStatus();
      console.log(
        session.connected
          ? `  ${c.green("●")} Wallet       CLI ${version}, session connected`
          : `  ${c.yellow("○")} Wallet       ${c.dim(`CLI ${version}, no session — run: baw auth signin --json`)}`,
      );
    } catch (err) {
      console.log(`  ${c.yellow("○")} Wallet       ${c.dim(`CLI ${version}, ${(err as Error).message}`)}`);
    }
  }

  const ledger = verifyLedger();
  console.log(
    ledger.records === 0
      ? `  ${c.dim("○")} Ledger       ${c.dim("no decisions recorded yet")}`
      : ledger.ok
        ? `  ${c.green("●")} Ledger       ${ledger.records} records, chain verified${ledger.signatureValid ? ", signature valid" : ""}`
        : `  ${c.red("✗")} Ledger       ${c.red(`broken at record ${ledger.brokenAt}: ${ledger.reason}`)}`,
  );

  const live = isLiveEnabled(policy);
  console.log(
    live
      ? `  ${c.red("●")} Execution    ${c.bold("ENABLED")} — orders will be transmitted`
      : `  ${c.green("○")} Execution    ${c.dim(`disabled (mode "${policy.mode}", CRUCIBLE_LIVE ${process.env.CRUCIBLE_LIVE === "1" ? "set" : "unset"})`)}`,
  );
  console.log();
  return 0;
}

function cmdVerify(): number {
  const r = verifyLedger();
  console.log();
  if (r.records === 0) {
    console.log(c.dim("  No decisions recorded yet, so there is nothing to verify."));
    console.log();
    return 0;
  }
  console.log(
    r.ok
      ? `  ${c.green("✓")} ${r.records} records, chain verified, signature ${r.signatureValid ? c.green("valid") : c.yellow("not checked")}.`
      : `  ${c.red("✗")} Verification FAILED at record ${r.brokenAt}: ${r.reason}`,
  );
  console.log();
  return r.ok ? 0 : 1;
}

async function cmdSample(): Promise<number> {
  console.log(c.dim("\n  Sweeping every symbol and size once...\n"));
  const { ok, failed } = await sampleSweep();
  console.log(`  ${ok} priced, ${failed} failed. Written to data/samples.jsonl\n`);
  return failed > 0 ? 1 : 0;
}

const HELP = `
  ${c.bold("crucible")} — smart execution for Binance agents

  ${c.bold("COMMANDS")}
    quote      Price an order on every venue, no decision
    route      Choose a venue and style, and run the risk engine
    status     What can actually execute right now
    policy     Show which rules are active
    verify     Recompute the decision ledger and check its signature
    sample     Take one evidence sample across all symbols and sizes
    samples    Summarise the evidence collected so far

  ${c.bold("OPTIONS")}
    --symbol   Trading pair                        ${c.dim("(default BNBUSDT)")}
    --side     BUY or SELL                         ${c.dim("(default BUY)")}
    --usd      Size in the quote asset
    --qty      Size in the base asset              ${c.dim("(give one of --usd or --qty)")}
    --equity   Simulated account equity for risk   ${c.dim("(default 100000)")}
    --config   Policy file                         ${c.dim("(default crucible.config.json)")}
    --json     Machine-readable output

  ${c.bold("EXAMPLES")}
    crucible quote  --symbol BNBUSDT --usd 500
    crucible route  --symbol BNBUSDT --usd 50000
    crucible route  --symbol BNBUSDT --usd 2000000
    crucible samples
`;

async function main(): Promise<number> {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  try {
    switch (cmd) {
      case "quote": return await cmdQuote(args);
      case "route": return await cmdRoute(args);
      case "policy": return cmdPolicy(args);
      case "status": return await cmdStatus(args);
      case "verify": return cmdVerify();
      case "sample": return await cmdSample();
      case "samples": return cmdSamples(args);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        console.log(HELP);
        return 0;
      default:
        console.error(c.red(`\n  Unknown command "${cmd}".`));
        console.log(HELP);
        return 2;
    }
  } catch (err) {
    if (
      err instanceof RouteError ||
      err instanceof ConfigError ||
      err instanceof SnapshotError ||
      err instanceof BinanceError ||
      err instanceof OnchainError
    ) {
      console.error(`\n  ${c.red("✗")} ${err.message}\n`);
      return 2;
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
