#!/usr/bin/env node
/**
 * Grade the cost model against a run of real fills.
 *
 * One execution proves the path and says nothing about accuracy. This sends a
 * series of small orders through the whole product — route, policy, execute,
 * read the fill back, receipt — and then prints what the model got wrong across
 * all of them. Every order is a real order on a real matching engine; the only
 * thing that is not real is the money, which is why this is safe to run and why
 * it is the fastest way to turn one sample into a curve.
 *
 * It alternates buys and sells so the account's balances come back to roughly
 * where they started, and pauses between orders so the exchange's rate limits
 * and this product's own hourly brake are both respected.
 *
 * Refuses to run against the live exchange. The point is a lot of cheap
 * samples, and that is exactly the wrong reason to spend real money.
 *
 *   node --experimental-strip-types scripts/demo-sweep.ts
 *   node --experimental-strip-types scripts/demo-sweep.ts --sizes 10,25,50 --pairs BNBUSDT,ETHUSDT
 */

import { takeSnapshot } from "../src/snapshot.ts";
import { measuredImpactBps, route } from "../src/decide/router.ts";
import { evaluate } from "../src/risk/engine.ts";
import { loadPolicy } from "../src/config.ts";
import { execute, UnconfirmedError } from "../src/exec/execute.ts";
import { calibration } from "../src/exec/calibration.ts";
import { Ledger } from "../src/ledger/chain.ts";
import { deriveState, emptyState } from "../src/risk/state.ts";
import { credentialsFromEnv, DEMO, MAINNET } from "../src/exec/binance-rest.ts";
import { fetchMid } from "../src/venues/binance.ts";
import { resolveCommission } from "../src/venues/commission.ts";
import type { Side } from "../src/types.ts";

const colour = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;
const paint = (code: string, s: string) => (colour ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => paint("2", s);
const bold = (s: string) => paint("1", s);
const green = (s: string) => paint("32", s);
const red = (s: string) => paint("31", s);
const yellow = (s: string) => paint("33", s);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const sizes = (arg("sizes") ?? "10,20,35,60,100").split(",").map(Number).filter((n) => n > 0);
const pairs = (arg("pairs") ?? "BNBUSDT").split(",").map((s) => s.trim().toUpperCase());
const pauseMs = Number(arg("pause") ?? 4000);

const baseUrl = process.env.CRUCIBLE_BINANCE_BASE ?? DEMO;
if (baseUrl === MAINNET) {
  console.error(
    "demo-sweep refuses to run against the live exchange. It exists to collect many cheap samples,\n" +
      "which is the wrong reason to spend real money. Point CRUCIBLE_BINANCE_BASE at Demo Mode.",
  );
  process.exit(2);
}

let credentials: ReturnType<typeof credentialsFromEnv>;
try {
  credentials = credentialsFromEnv();
} catch (err) {
  console.error(`demo-sweep needs exchange credentials: ${(err as Error).message}`);
  process.exit(2);
}

const { policy } = loadPolicy();
if (policy.mode !== "live" || process.env.CRUCIBLE_LIVE !== "1") {
  console.error(
    'demo-sweep sends real orders, so both switches have to agree: policy mode "live" in\n' +
      "crucible.config.json, and CRUCIBLE_LIVE=1 in this shell. Nothing has been sent.",
  );
  process.exit(2);
}

const ledger = new Ledger();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Outcome {
  symbol: string;
  side: Side;
  usd: number;
  predictedBps: number;
  realisedBps: number | null;
  errorBps: number | null;
  venue: string;
  note?: string;
}

const results: Outcome[] = [];

console.log();
console.log(`  ${bold("Grading the cost model against real fills.")}`);
console.log(`  ${dim(`${baseUrl} · ${pairs.join(", ")} · sizes ${sizes.map((s) => "$" + s).join(", ")} · buy then sell each`)}`);

for (const symbol of pairs) {
  for (const usd of sizes) {
    // Buy, then sell the same size back, so the account's balances end roughly
    // where they started and both sides of the book get sampled.
    for (const side of ["BUY", "SELL"] as const) {
      const label = `${side} $${usd} ${symbol}`;
      try {
        const mid = await fetchMid(symbol);
        const baseQty = usd / mid;
        const snapshot = await takeSnapshot({
          symbol,
          side,
          baseQty,
          includeWalletQuote: false,
          commission: await resolveCommission(symbol),
        });

        const plan = route({ intent: { symbol, side, baseQty }, snapshot, policy });
        const decision = evaluate(
          { symbol, side, type: "MARKET", market: "SPOT", quantity: baseQty, venue: plan.chosen.venue },
          {
            policy,
            account: { equityUsd: 100_000, positions: [], realisedPnlTodayUsd: 0, source: "simulated" },
            state: (() => {
              try {
                return deriveState(ledger.read());
              } catch {
                return emptyState();
              }
            })(),
            markPrice: snapshot.mid,
            now: new Date(),
            snapshot,
            impactBps: measuredImpactBps(snapshot, side, baseQty),
          },
        );

        if (decision.verdict === "BLOCK" || decision.verdict === "CONFIRM") {
          const why = decision.results.find((r) => r.verdict === decision.verdict);
          console.log(`  ${yellow("skip")} ${label.padEnd(22)} ${dim(`${decision.verdict}: ${why?.rule ?? ""} — ${why?.message ?? ""}`)}`);
          results.push({
            symbol, side, usd, venue: plan.chosen.venue,
            predictedBps: plan.chosen.totalBps, realisedBps: null, errorBps: null,
            note: `${decision.verdict} ${why?.rule ?? ""}`,
          });
          continue;
        }

        const receipt = await execute({ plan, snapshot, policy, binance: { baseUrl, credentials }, ledger });
        const err = receipt.errorBps;
        const mark = err === null ? yellow("?") : Math.abs(err) < 1 ? green("ok") : yellow("~");
        console.log(
          `  ${mark} ${label.padEnd(22)} ${plan.chosen.venue.padEnd(13)} ` +
            `predicted ${receipt.predicted.totalBps.toFixed(2).padStart(6)} bps  ` +
            `realised ${(receipt.realisedBps?.toFixed(2) ?? "  n/a").padStart(6)} bps  ` +
            `${err === null ? "" : dim(`error ${err >= 0 ? "+" : ""}${err.toFixed(2)} bps`)}`,
        );
        results.push({
          symbol, side, usd, venue: plan.chosen.venue,
          predictedBps: receipt.predicted.totalBps,
          realisedBps: receipt.realisedBps,
          errorBps: err,
        });
      } catch (err) {
        if (err instanceof UnconfirmedError) {
          console.log(`  ${red("!!")} ${label.padEnd(22)} ${red("unconfirmed")} ${dim(`— run: crucible reconcile --plan ${err.planId}`)}`);
          console.log(`  ${red("Stopping.")} An unresolved order must be settled before more are sent.`);
          break;
        }
        const message = (err as Error).message;
        console.log(`  ${red("fail")} ${label.padEnd(22)} ${dim(message.split("\n")[0]!.slice(0, 120))}`);
        results.push({ symbol, side, usd, venue: "-", predictedBps: 0, realisedBps: null, errorBps: null, note: message.slice(0, 80) });
        // An insufficient balance will not fix itself on the next, larger order.
        if (/insufficient/i.test(message)) {
          console.log(`  ${yellow("Stopping: the account is out of balance for this side. Reset it on demo.binance.com.")}`);
          break;
        }
      }
      await sleep(pauseMs);
    }
  }
}

const graded = results.filter((r) => r.errorBps !== null);
console.log();
console.log(`  ${bold("Sent")} ${results.length}  ${bold("graded")} ${graded.length}`);

const report = calibration(ledger.read());
console.log();
console.log(`  ${bold("CALIBRATION")}`);
console.log(`  executions graded   ${report.samples}`);
if (report.samples > 0) {
  console.log(`  mean error          ${report.meanErrorBps!.toFixed(2)} bps   ${dim("positive means it cost more than predicted")}`);
  console.log(`  median error        ${report.medianErrorBps!.toFixed(2)} bps`);
  console.log(`  typical miss        ${report.meanAbsErrorBps!.toFixed(2)} bps`);
  console.log(`  worst miss          ${report.worstErrorBps!.toFixed(2)} bps`);
  for (const v of report.byVenue) {
    console.log(`    ${v.venue.padEnd(16)} ${String(v.samples).padStart(3)} runs   mean ${v.meanErrorBps.toFixed(2)} bps`);
  }
}
console.log();
console.log(`  ${report.verdict}`);
console.log();
