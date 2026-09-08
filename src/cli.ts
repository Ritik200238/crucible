#!/usr/bin/env node
/**
 * Crucible CLI.
 *
 * The same calls the MCP server makes, in a form a person can read: quote,
 * route, execute, policy, evidence, ledger verification and reachability.
 * There is no separate presentation path — what is printed here runs the same
 * code an agent drives, so a demo cannot show something the product does not do.
 *
 * Execution is reached through `route --execute` rather than a command of its
 * own. Plans are never written to disk, so a standalone `execute <id>` could
 * only ever name a plan that had already gone.
 */

import { takeSnapshot } from "./snapshot.ts";
import { priceAllRoutes } from "./cost/model.ts";
import { measuredImpactBps, route, RouteError } from "./decide/router.ts";
import { ConfigError, DEFAULT_POLICY, isLiveEnabled, loadPolicy } from "./config.ts";
import { BinanceError, fetchMid } from "./venues/binance.ts";
import { resolveCommission } from "./venues/commission.ts";
import { OnchainError } from "./venues/onchain.ts";
import { SnapshotError } from "./snapshot.ts";
import { isSample, readSamples, sampleSweep } from "./sampler/run.ts";
import { verifyLedger } from "./ledger/verify.ts";
import { checkClaim } from "./ledger/claims.ts";
import { execute, ExecutionError, reconcile } from "./exec/execute.ts";
import { calibration } from "./exec/calibration.ts";
import { credentialsFromEnv, type Credentials } from "./exec/binance-rest.ts";
import { Ledger, ledgerPaths, type LedgerRecord } from "./ledger/chain.ts";
import { deriveState, emptyState } from "./risk/state.ts";
import { DEMO, MAINNET } from "./exec/binance-rest.ts";
import { walletStatus, walletVersion } from "./exec/wallet.ts";
import { summarise } from "./sampler/analyse.ts";
import { ALL_RULES } from "./risk/rules.ts";
import { evaluate } from "./risk/engine.ts";
import type {
  CostEstimate,
  Decision,
  Plan,
  Policy,
  RollingState,
  Side,
  Snapshot,
} from "./types.ts";

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

/**
 * The cumulative counters, rebuilt from the ledger.
 *
 * Reading them fresh on every call is what makes the daily and hourly rules
 * mean anything. A missing or unreadable ledger yields empty counters, which is
 * the conservative direction: every cap then applies in full rather than
 * reading as already spent.
 */
function rollingState(): RollingState {
  try {
    return deriveState(new Ledger().read());
  } catch {
    return emptyState();
  }
}

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
  if (usd !== undefined) baseQty = usd / (await fetchMid(symbol));

  const snapshot = await takeSnapshot({
    symbol,
    side,
    baseQty,
    includeWalletQuote: true,
    commission: await resolveCommission(symbol),
  });
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
  // The error bar sits next to the number so a wide guess never reads like a
  // firm one.
  const band = c.dim(`± ${r.uncertaintyBps.toFixed(2)}`.padStart(8));
  console.log(
    `  ${mark} ${(chosen ? c.bold(label) : label).padEnd(chosen && colour ? 34 : 26)} ${total}${est}${band}  ${c.dim(money(r.totalUsd))}`,
  );
  for (const comp of r.components) {
    console.log(
      `      ${c.dim(comp.name.padEnd(20))} ${c.dim(comp.bps.toFixed(3).padStart(9))}   ${c.dim(comp.detail)}`,
    );
  }
  console.log(`      ${c.dim("effective price".padEnd(20))} ${c.dim(r.effectivePrice.toFixed(quoteAssetPrecision).padStart(9))}`);
  // Risks with no expected cost still belong next to the price, or the cheaper
  // route quietly looks strictly better than it is.
  for (const note of r.notes) {
    console.log(`      ${c.dim("!".padEnd(20))} ${c.dim(note)}`);
  }
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
  } else {
    console.log(
      c.dim(
        `  fees: your account's — maker ${(snapshot.commission.maker * 10_000).toFixed(2)} bps, taker ` +
          `${(snapshot.commission.taker * 10_000).toFixed(2)} bps, ` +
          (snapshot.commission.via === "agent-os" ? "read through Binance Agent OS" : "read with your API key"),
      ),
    );
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

/**
 * Carry a plan through to execution, in the same process that made it.
 *
 * Plans are deliberately never written to disk, so a separate `execute` command
 * taking an id could not work: by the time it ran, the plan it named would be
 * gone. Routing and executing in one invocation is the only shape that keeps
 * the decision and the order tied together without persisting an authorisation.
 */
async function runExecution(
  plan: Plan,
  snapshot: Snapshot,
  policy: Policy,
  verdict: Decision["verdict"],
): Promise<number> {
  console.log();
  if (verdict === "BLOCK") {
    console.log(`  ${c.red("✗")} The risk engine refused this order. Nothing will be sent.`);
    console.log();
    return 1;
  }
  if (verdict === "CONFIRM") {
    console.log(
      `  ${c.yellow("!")} This order needs a human decision first, so --execute will not send it.`,
    );
    console.log(c.dim("    Raise confirmAboveNotionalUsd, or trade smaller."));
    console.log();
    return 1;
  }

  const baseUrl = process.env.CRUCIBLE_BINANCE_BASE ?? DEMO;
  let binance: { baseUrl: string; credentials: ReturnType<typeof credentialsFromEnv> } | undefined;
  try {
    binance = { baseUrl, credentials: credentialsFromEnv() };
  } catch {
    binance = undefined;
  }

  if (baseUrl === MAINNET) {
    console.log(`  ${c.red("● LIVE EXCHANGE")} ${c.dim("— this spends real money.")}`);
  }

  try {
    const receipt = await execute({ plan, snapshot, policy, ...(binance ? { binance } : {}) });

    console.log(`  ${c.bold("RECEIPT")} ${receipt.planId}   ${c.dim(receipt.fingerprint)}`);
    console.log(
      `  predicted ${bps(receipt.predicted.totalBps)}` +
        (receipt.realisedBps === null
          ? `   ${c.yellow("realised unavailable")}`
          : `   realised ${bps(receipt.realisedBps)} ` +
            c.dim(`(price ${bps(receipt.realisedGrossBps)} + fee ${bps(receipt.realisedFeeBps ?? 0)})`) +
            `   error ${bps(receipt.errorBps ?? 0)}`),
    );
    if (receipt.errorUnavailable) console.log(c.yellow(`  ${receipt.errorUnavailable}`));
    if (receipt.alternative && receipt.savingUsd !== null) {
      console.log(
        `  ${c.green("saved")} ${money(receipt.savingUsd)} ` +
          c.dim(`against ${venueName(receipt.alternative.venue)} at ${bps(receipt.alternative.totalBps)}`),
      );
    }
    for (const f of receipt.fills) {
      const fees = f.fees.length === 0 ? "no commission" : f.fees.map((x) => `${x.amount} ${x.asset}`).join(" + ");
      console.log(
        `  ${f.status === "FILLED" ? c.green("●") : c.yellow("○")} ${f.status} ` +
          `${f.filledBaseQty} at ${f.avgPrice}  ${c.dim(fees)}`,
      );
      console.log(c.dim(`      ${f.reference}  ${f.confirmedBy}`));
    }
    console.log();
    return 0;
  } catch (err) {
    console.log(`  ${c.red("✗")} ${(err as Error).message}`);
    console.log();
    return 3;
  }
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
      state: rollingState(),
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

  if (args.get("execute") === "true") {
    return runExecution(plan, snapshot, policy, decision.verdict);
  }

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

  // The account's real fee, or why the public schedule is standing in for it.
  // Commission is the largest cost on the exchange side, so which one is in use
  // is the first thing to know about any quote this instance produces.
  const symbol = (args.get("symbol") ?? "BNBUSDT").toUpperCase();
  const fees = await resolveCommission(symbol);
  console.log(
    fees.source === "account"
      ? `  ${c.green("●")} Fees         ${symbol} maker ${(fees.maker * 10_000).toFixed(2)} bps, taker ${(fees.taker * 10_000).toFixed(2)} bps` +
        (fees.standard ? c.dim(` (standard ${(fees.standard.taker * 10_000).toFixed(2)} bps)`) : "") +
        ` — ${fees.detail ?? "read from your account"}`
      : `  ${c.yellow("○")} Fees         ${c.dim(`public VIP 0 schedule for ${symbol}. ${fees.detail?.replace(/^Public VIP 0 schedule\. /, "") ?? ""}`)}`,
  );

  const ledger = verifyLedger();
  console.log(
    !ledger.present
      ? `  ${c.yellow("○")} Ledger       ${c.dim(`no ledger file at ${ledgerPaths().ledger} — nothing recorded here yet`)}`
      : ledger.records === 0
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

  // Orders that left for a venue and were never read back. Shown here because
  // this is the screen an operator looks at when something felt wrong, and an
  // order in this state is the one thing that must not be retried blind.
  const unresolved = rollingState().unresolved;
  if (unresolved.length > 0) {
    console.log();
    console.log(`  ${c.red("!")} ${c.bold(`${unresolved.length} order(s) sent and not yet resolved`)}`);
    for (const u of unresolved) {
      console.log(
        `      plan ${u.planId}  ${u.venue}  ref ${u.reference}  $${u.quoteQty.toFixed(2)} held since ${u.since}`,
      );
    }
    console.log(c.dim(`      Their notional counts against your caps until: crucible reconcile --plan <id>`));
  }
  console.log();
  return 0;
}

/**
 * Close an order whose outcome this process lost.
 *
 * Reads the venue again and writes what it said. Nothing here guesses: an
 * order the venue still reports as open stays held.
 */
async function cmdReconcile(args: Map<string, string>): Promise<number> {
  const planId = args.get("plan");
  if (!planId || planId === "true") {
    console.error("  Give the plan to reconcile: crucible reconcile --plan <id>");
    return 2;
  }

  let binance: { baseUrl: string; credentials: Credentials } | undefined;
  try {
    binance = { baseUrl: process.env.CRUCIBLE_BINANCE_BASE ?? DEMO, credentials: credentialsFromEnv() };
  } catch {
    binance = undefined;
  }

  const result = await reconcile({ planId, ledger: new Ledger(), ...(binance ? { binance } : {}) });

  console.log();
  console.log(`  ${c.bold("RECONCILED")}  plan ${result.planId}`);
  switch (result.outcome) {
    case "filled":
      console.log(`  ${c.green("●")} The venue reports it filled. Booked as a fill; the hold is released.`);
      break;
    case "partial":
      console.log(`  ${c.yellow("●")} Partly filled. What traded is booked; the hold is released.`);
      break;
    case "never_filled":
      console.log(`  ${c.dim("○")} The venue reports it never filled. Nothing booked; the hold is released.`);
      break;
    case "still_unresolved":
      console.log(
        `  ${c.red("!")} Still open at the venue: ${result.stillOpen.join(", ")}. The hold stays. Try again shortly.`,
      );
      break;
  }
  for (const f of result.fills) {
    console.log(
      `      ${f.venue}  ${f.status}  ${f.filledBaseQty.toFixed(6)} @ ${f.avgPrice.toFixed(4)}  ref ${f.reference}`,
    );
  }
  if (result.realisedBps !== null) {
    console.log(
      `      realised ${result.realisedBps.toFixed(2)} bps` +
        (result.errorBps !== null
          ? `, ${result.errorBps >= 0 ? "+" : ""}${result.errorBps.toFixed(2)} bps against the prediction`
          : ""),
    );
  }
  console.log();
  return result.outcome === "still_unresolved" ? 1 : 0;
}

/**
 * How well the cost model has been predicting.
 *
 * Reads the ledger rather than any separate record, so the grade comes from the
 * same signed history as everything else and cannot be curated.
 */
function cmdCalibration(args: Map<string, string>): number {
  let report;
  try {
    report = calibration(new Ledger().read());
  } catch {
    report = calibration([]);
  }

  if (args.get("json") === "true") {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  console.log();
  console.log(`  ${c.bold("MODEL CALIBRATION")}`);
  console.log();

  if (report.samples === 0) {
    console.log(`  ${c.yellow("○")} ${report.verdict}`);
    console.log();
    return 0;
  }

  console.log(`  executions graded   ${report.samples}`);
  if (report.incomparable > 0) {
    console.log(c.dim(`  not comparable      ${report.incomparable}`));
  }
  console.log(`  mean error          ${bps(report.meanErrorBps ?? 0)}   ${c.dim("positive means it cost more than predicted")}`);
  console.log(`  median error        ${bps(report.medianErrorBps ?? 0)}`);
  console.log(`  typical miss        ${bps(report.meanAbsErrorBps ?? 0)}`);
  console.log(`  worst miss          ${bps(report.worstErrorBps ?? 0)}`);

  if (report.byVenue.length > 0) {
    console.log();
    for (const v of report.byVenue) {
      console.log(`    ${venueName(v.venue).padEnd(16)} ${String(v.samples).padStart(4)} runs   mean ${bps(v.meanErrorBps)}`);
    }
  }
  console.log();
  console.log(c.dim(`  ${report.verdict}`));
  console.log();
  return 0;
}

/**
 * Check a summary against the ledger.
 *
 * The agent-facing tool and this command share one checker; this exists so an
 * operator can paste what an agent said and see whether the record supports it.
 */
function cmdClaim(args: Map<string, string>): number {
  const summary = args.get("text");
  if (!summary || summary === "true") {
    console.error('  Give the summary to check: crucible claim --text "Bought 0.66 BNB and saved 8 bps"');
    return 2;
  }
  let records: LedgerRecord[];
  try {
    records = new Ledger().read();
  } catch (err) {
    console.error(`  The ledger could not be read: ${(err as Error).message}`);
    return 1;
  }
  const r = checkClaim(summary, records);
  console.log();
  if (r.ok) {
    console.log(`  ${c.green("OK")}  every figure is carried by a record (${r.grounded.length} grounded); nothing that happened is left out.`);
  } else {
    console.log(`  ${c.red("REFUSED")}  ${r.problems.length} problem(s)`);
    for (const p of r.problems) console.log(`    - ${c.dim(p.kind)}  ${p.detail}`);
    console.log();
    console.log(`  ${c.bold("Say this instead")} ${c.dim("(built only from records)")}`);
    console.log(`  ${r.replacement}`);
  }
  console.log();
  return r.ok ? 0 : 1;
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
    calibration  How well the cost model has predicted real fills
    sample     Take one evidence sample across all symbols and sizes
    samples    Summarise the evidence collected so far

  ${c.bold("OPTIONS")}
    --symbol   Trading pair                        ${c.dim("(default BNBUSDT)")}
    --side     BUY or SELL                         ${c.dim("(default BUY)")}
    --usd      Size in the quote asset
    --qty      Size in the base asset              ${c.dim("(give one of --usd or --qty)")}
    --equity   Simulated account equity for risk   ${c.dim("(default 100000)")}
    --config   Policy file                         ${c.dim("(default crucible.config.json)")}
    --execute  Send the order if it clears, and print the receipt
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
      case "calibration": return cmdCalibration(args);
      case "reconcile": return await cmdReconcile(args);
      case "claim": return cmdClaim(args);
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
      err instanceof ExecutionError ||
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
