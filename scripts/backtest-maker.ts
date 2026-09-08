#!/usr/bin/env node
/**
 * Grade the maker fill model against real Binance market flow.
 *
 * Fetches the recent aggregated-trade tape for a symbol and runs the
 * out-of-sample backtest over it: at each point the flow rate is measured from
 * the past, the model predicts a resting order's chance of filling, and the
 * future is read to see whether it did. The result is a calibration table and
 * a Brier score — the maker model's one modelled quantity, checked against the
 * market rather than asserted.
 *
 *   node --experimental-strip-types scripts/backtest-maker.ts
 *   node --experimental-strip-types scripts/backtest-maker.ts --symbol ETHUSDT --limit 1000
 */

import { fetchAggTrades } from "../src/venues/binance.ts";
import { backtestFillModel } from "../src/analysis/maker-backtest.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const symbol = arg("symbol", "BNBUSDT").toUpperCase();
const limit = Number(arg("limit", "1000"));

const colour = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;
const dim = (s: string) => (colour ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (colour ? `\x1b[1m${s}\x1b[0m` : s);

console.log();
console.log(`  ${bold("Grading the maker fill model against real flow.")}`);
console.log(dim(`  ${symbol}, last ${limit} aggregated trades from Binance.`));

const trades = await fetchAggTrades(symbol, limit);
const spanSec = (Math.max(...trades.map((t) => t.time)) - Math.min(...trades.map((t) => t.time))) / 1000;
console.log(dim(`  ${trades.length} trades over ${(spanSec / 60).toFixed(1)} minutes.`));

// Sizes and queue positions a resting order might really have, in the base
// asset. The point is a spread of predicted probabilities, not one.
const report = backtestFillModel(trades, {
  sizes: [0.5, 2, 8, 20],
  queueAheads: [0, 1, 5, 20],
  trailingSec: 120,
});

console.log();
if (report.samples < 200) {
  console.log(`  ${report.verdict}`);
  console.log(dim("  Run again in a busier minute, or raise --limit."));
  process.exit(0);
}

console.log(`  ${bold("Calibration")} ${dim("(predicted band -> what actually filled)")}`);
for (const b of report.buckets) {
  const width = Math.round(b.observedFillRate * 40);
  const bar = "#".repeat(width) + dim("-".repeat(40 - width));
  console.log(
    `  ${(b.from * 100).toString().padStart(3)}-${((b.from + 0.1) * 100).toFixed(0).padStart(3)}%  ` +
      `${bar}  ${(b.observedFillRate * 100).toFixed(0).padStart(3)}% filled  ${dim(`n=${b.samples}`)}`,
  );
}
console.log();
console.log(`  samples        ${report.samples}`);
console.log(`  predicted      ${(report.meanPredicted * 100).toFixed(1)}% expected to fill`);
console.log(`  observed       ${(report.observedFillRate * 100).toFixed(1)}% did`);
console.log(`  Brier score    ${report.brierScore.toFixed(3)} ${dim("(0.25 is a coin toss; lower is sharper)")}`);
console.log();
console.log(`  ${report.verdict}`);
console.log();
