import { test } from "node:test";
import assert from "node:assert/strict";

import {
  describeCrossover,
  edgeBps,
  median,
  summarise,
  BINANCE_MAKER_ROUTE,
  BINANCE_TAKER_ROUTE,
  ONCHAIN_ROUTE,
  type Bucket,
} from "../src/sampler/analyse.ts";
import type { Sample } from "../src/sampler/run.ts";

const AT = "2026-09-08T12:00:00.000Z";

/** One sampled row. Costs are in bps of mid, which is what the file records. */
function sample(over: Partial<Sample> = {}): Sample {
  return {
    at: AT,
    symbol: "BNBUSDT",
    side: "BUY",
    notionalUsd: 500,
    baseQty: 0.665,
    mid: 752,
    spreadBps: 0.266,
    snapshotHash: "1f0a7c4b2e9d6538",
    routes: { [BINANCE_TAKER_ROUTE]: 12, [BINANCE_MAKER_ROUTE]: 11, [ONCHAIN_ROUTE]: 9 },
    cheapest: ONCHAIN_ROUTE,
    edgeBps: 2,
    ...over,
  };
}

/** A row priced only by its route costs; everything else is scenery. */
function priced(routes: Record<string, number>, over: Partial<Sample> = {}): Sample {
  return sample({ routes, ...over });
}

function bucket(over: Partial<Bucket> = {}): Bucket {
  return {
    symbol: "BNBUSDT",
    notionalUsd: 500,
    count: 4,
    onchainWinRate: 1,
    medianEdgeBps: 2,
    medianOnchainBps: 9,
    medianBinanceBps: 11,
    medianOnchainParts: {},
    ...over,
  };
}

// ---------------------------------------------------------------------------
// median
// ---------------------------------------------------------------------------

test("median takes the middle of an odd-length set", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([10, -4, 0, 7, 2]), 2);
});

test("median averages the two middles of an even-length set", () => {
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([1, 2]), 1.5);
});

test("median of one value is that value", () => {
  assert.equal(median([7]), 7);
  assert.equal(median([-0.5]), -0.5);
});

test("median of nothing is NaN rather than zero", () => {
  // Zero would read as a real measurement of no edge.
  assert.ok(Number.isNaN(median([])));
});

test("median leaves the caller's array in the order it was given", () => {
  const xs = [3, 1, 2];
  median(xs);

  assert.deepEqual(xs, [3, 1, 2]);
});

// ---------------------------------------------------------------------------
// edgeBps
// ---------------------------------------------------------------------------

test("edgeBps is positive when the pool was the cheaper venue", () => {
  const edge = edgeBps(
    priced({ [BINANCE_TAKER_ROUTE]: 12, [BINANCE_MAKER_ROUTE]: 11, [ONCHAIN_ROUTE]: 9 }),
  );

  assert.equal(edge, 2);
});

test("edgeBps is negative when Binance was the cheaper venue", () => {
  const edge = edgeBps(
    priced({ [BINANCE_TAKER_ROUTE]: 12, [BINANCE_MAKER_ROUTE]: 11, [ONCHAIN_ROUTE]: 14 }),
  );

  assert.equal(edge, -3);
});

test("edgeBps measures against the best Binance route, not the first one listed", () => {
  // The taker route is written first, and is the more expensive of the two.
  // Using it would flatter the pool by 4 bps on this row alone.
  const edge = edgeBps(
    priced({ [BINANCE_TAKER_ROUTE]: 12, [BINANCE_MAKER_ROUTE]: 8, [ONCHAIN_ROUTE]: 5 }),
  );

  assert.equal(edge, 3);
});

test("edgeBps refuses to score a sample that only saw one venue", () => {
  assert.equal(edgeBps(priced({ [BINANCE_TAKER_ROUTE]: 12, [BINANCE_MAKER_ROUTE]: 11 })), null);
  assert.equal(edgeBps(priced({ [ONCHAIN_ROUTE]: 9 })), null);
  assert.equal(edgeBps(priced({})), null);
});

test("edgeBps works from whichever Binance route was priced", () => {
  assert.equal(edgeBps(priced({ [BINANCE_TAKER_ROUTE]: 12, [ONCHAIN_ROUTE]: 9 })), 3);
  assert.equal(edgeBps(priced({ [BINANCE_MAKER_ROUTE]: 11, [ONCHAIN_ROUTE]: 9 })), 2);
});

// ---------------------------------------------------------------------------
// summarise
// ---------------------------------------------------------------------------

test("summarise buckets by symbol and by size", () => {
  const report = summarise([
    sample({ symbol: "BNBUSDT", notionalUsd: 500 }),
    sample({ symbol: "BNBUSDT", notionalUsd: 500 }),
    sample({ symbol: "BNBUSDT", notionalUsd: 5_000 }),
    sample({ symbol: "ETHUSDT", notionalUsd: 500 }),
  ]);

  assert.deepEqual(
    report.buckets.map((b) => [b.symbol, b.notionalUsd, b.count]),
    [
      ["BNBUSDT", 500, 2],
      ["BNBUSDT", 5_000, 1],
      ["ETHUSDT", 500, 1],
    ],
  );
  assert.equal(report.total, 4);
});

test("summarise scores the win rate as the share of samples the pool actually won", () => {
  const rows = [9, 8, 12, 11].map((onchain) =>
    priced({ [BINANCE_TAKER_ROUTE]: 12, [BINANCE_MAKER_ROUTE]: 11, [ONCHAIN_ROUTE]: onchain }),
  );

  const report = summarise(rows);
  const only = report.buckets[0]!;

  // Edges are +2, +3, -1 and 0. A tie is not a win.
  assert.equal(only.onchainWinRate, 0.5);
  assert.equal(report.onchainWinRate, 0.5);
  assert.equal(only.medianEdgeBps, 1);
  assert.equal(report.medianEdgeBps, 1);
  assert.equal(only.medianOnchainBps, 10);
  assert.equal(only.medianBinanceBps, 11);
});

test("summarise leaves out samples that could not be scored", () => {
  const report = summarise([
    sample(),
    sample(),
    // The pool did not answer, so this row says nothing about which is cheaper.
    priced({ [BINANCE_TAKER_ROUTE]: 12, [BINANCE_MAKER_ROUTE]: 11 }),
  ]);

  assert.equal(report.total, 2);
  assert.equal(report.buckets.length, 1);
  assert.equal(report.buckets[0]!.count, 2);
  assert.equal(report.onchainWinRate, 1);
});

test("summarise takes the span from the sampling window, not from the usable rows", () => {
  const report = summarise([
    sample({ at: "2026-09-08T12:00:00.000Z" }),
    sample({ at: "2026-09-08T13:30:00.000Z" }),
    // An unscoreable row still happened, so it still counts toward the window.
    priced({ [BINANCE_TAKER_ROUTE]: 12 }, { at: "2026-09-08T15:00:00.000Z" }),
  ]);

  assert.equal(report.from, "2026-09-08T12:00:00.000Z");
  assert.equal(report.to, "2026-09-08T15:00:00.000Z");
  assert.equal(report.spanHours, 3);
  assert.equal(report.total, 2);
});

test("summarise orders the window even when the rows arrive out of order", () => {
  const report = summarise([
    sample({ at: "2026-09-08T15:00:00.000Z" }),
    sample({ at: "2026-09-08T12:00:00.000Z" }),
    sample({ at: "2026-09-08T13:00:00.000Z" }),
  ]);

  assert.equal(report.from, "2026-09-08T12:00:00.000Z");
  assert.equal(report.to, "2026-09-08T15:00:00.000Z");
  assert.equal(report.spanHours, 3);
});

test("summarise reports no span for a single sample", () => {
  const report = summarise([sample()]);

  assert.equal(report.spanHours, 0);
  assert.equal(report.from, report.to);
  assert.equal(report.total, 1);
});

test("summarise survives having nothing to summarise", () => {
  const report = summarise([], 4);

  assert.equal(report.total, 0);
  assert.equal(report.failures, 4);
  assert.equal(report.from, "");
  assert.equal(report.to, "");
  assert.equal(report.spanHours, 0);
  assert.deepEqual(report.buckets, []);
  assert.equal(report.onchainWinRate, 0);
  assert.ok(Number.isNaN(report.medianEdgeBps));
  assert.equal(report.crossoverNote, "");
});

test("summarise takes the median of each named on-chain cost component", () => {
  const report = summarise([
    sample({ onchainParts: { "pool fee": 5, gas: 0.2, "price impact": 1 } }),
    sample({ onchainParts: { "pool fee": 5, gas: 0.4, "price impact": 3 } }),
    sample({ onchainParts: { "pool fee": 5, gas: 0.9, "price impact": 2 } }),
  ]);

  assert.deepEqual(report.buckets[0]!.medianOnchainParts, {
    "pool fee": 5,
    gas: 0.4,
    "price impact": 2,
  });
});

test("summarise carries the failure count and the crossover note", () => {
  const report = summarise([sample({ notionalUsd: 500 }), sample({ notionalUsd: 5_000 })], 7);

  assert.equal(report.failures, 7);
  assert.equal(report.crossoverNote, describeCrossover(report.buckets));
});

// ---------------------------------------------------------------------------
// describeCrossover
// ---------------------------------------------------------------------------

test("describeCrossover says the pool won everywhere when it did", () => {
  const note = describeCrossover([
    bucket({ notionalUsd: 500, medianEdgeBps: 4 }),
    bucket({ notionalUsd: 5_000, medianEdgeBps: 2 }),
    bucket({ notionalUsd: 25_000, medianEdgeBps: 0.5 }),
  ]);

  assert.equal(note, "BNBUSDT: on-chain was cheaper at every size sampled, up to $25,000.");
});

test("describeCrossover names the size where the cheaper venue changes", () => {
  const note = describeCrossover([
    bucket({ notionalUsd: 500, medianEdgeBps: 4 }),
    bucket({ notionalUsd: 5_000, medianEdgeBps: -3 }),
    bucket({ notionalUsd: 25_000, medianEdgeBps: -9 }),
  ]);

  assert.equal(
    note,
    "BNBUSDT: on-chain is cheaper to about $500, and Binance takes over by $5,000.",
  );
});

test("describeCrossover says Binance won everywhere when the smallest size already lost", () => {
  const note = describeCrossover([
    bucket({ notionalUsd: 500, medianEdgeBps: -1 }),
    bucket({ notionalUsd: 5_000, medianEdgeBps: -6 }),
  ]);

  assert.equal(note, "BNBUSDT: Binance was cheaper at every size sampled.");
});

test("describeCrossover reads a tie at the smallest size as Binance holding", () => {
  // An edge of exactly zero is not a win for the pool, so there is nothing to
  // cross over from.
  const note = describeCrossover([
    bucket({ notionalUsd: 500, medianEdgeBps: 0 }),
    bucket({ notionalUsd: 5_000, medianEdgeBps: -6 }),
  ]);

  assert.equal(note, "BNBUSDT: Binance was cheaper at every size sampled.");
});

test("describeCrossover handles a single bucket either way", () => {
  assert.equal(
    describeCrossover([bucket({ notionalUsd: 500, medianEdgeBps: 4 })]),
    "BNBUSDT: on-chain was cheaper at every size sampled, up to $500.",
  );
  assert.equal(
    describeCrossover([bucket({ notionalUsd: 500, medianEdgeBps: -4 })]),
    "BNBUSDT: Binance was cheaper at every size sampled.",
  );
  assert.equal(describeCrossover([]), "");
});

test("describeCrossover orders the sizes itself", () => {
  const note = describeCrossover([
    bucket({ notionalUsd: 25_000, medianEdgeBps: -9 }),
    bucket({ notionalUsd: 500, medianEdgeBps: 4 }),
    bucket({ notionalUsd: 5_000, medianEdgeBps: -3 }),
  ]);

  assert.equal(
    note,
    "BNBUSDT: on-chain is cheaper to about $500, and Binance takes over by $5,000.",
  );
});

test("describeCrossover reports each symbol separately", () => {
  // Pool depth differs by pair, so one crossover figure across symbols would be
  // an average of two markets and true of neither.
  const note = describeCrossover([
    bucket({ symbol: "BNBUSDT", notionalUsd: 500, medianEdgeBps: 4 }),
    bucket({ symbol: "BNBUSDT", notionalUsd: 5_000, medianEdgeBps: -3 }),
    bucket({ symbol: "ETHUSDT", notionalUsd: 500, medianEdgeBps: -2 }),
  ]);

  assert.equal(
    note,
    "BNBUSDT: on-chain is cheaper to about $500, and Binance takes over by $5,000. " +
      "ETHUSDT: Binance was cheaper at every size sampled.",
  );
});
