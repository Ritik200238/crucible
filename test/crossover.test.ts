/**
 * Finding the size where the cheaper venue changes.
 *
 * The product's whole claim is that no venue is cheapest at every size. This
 * turns that claim into a number, so the number has to be right — and, more
 * importantly, has to be absent when there is no crossing rather than invented
 * by bisecting a curve that never crosses.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { findCrossover, type Quoter } from "../src/analysis/crossover.ts";
import type { CostEstimate } from "../src/types.ts";

const route = (venue: "BINANCE_SPOT" | "ONCHAIN", style: "TAKER" | "MAKER", bps: number, unavailable?: string): CostEstimate => ({
  venue,
  style,
  components: [],
  totalBps: bps,
  totalUsd: 0,
  effectivePrice: 100,
  hasEstimates: false,
  notes: [],
  uncertaintyBps: 0,
  ...(unavailable ? { unavailable } : {}),
});

/**
 * A market with a real crossing.
 *
 * The exchange charges a flat 10 bps whatever the size. The pool charges 1 bps
 * plus an impact that grows with size, so it wins when small and loses when
 * large. They cross where impact reaches 9 bps.
 */
function crossingMarket(crossAtUsd: number): Quoter {
  return async (usd: number) => ({
    mid: 100,
    routes: [
      route("BINANCE_SPOT", "TAKER", 10),
      route("ONCHAIN", "TAKER", 1 + (9 * usd) / crossAtUsd),
    ],
  });
}

describe("when the venues cross", () => {
  test("the crossover is found, and close to where it really is", async () => {
    const result = await findCrossover(crossingMarket(50_000), { symbol: "BNBUSDT", side: "BUY", minUsd: 100, maxUsd: 500_000 });

    assert.equal(result.cheapestWhenSmall, "on-chain");
    assert.equal(result.cheapestWhenLarge, "Binance spot taker");
    assert.ok(result.crossoverUsd !== null, "a crossing exists and must be reported");
    // Bisection should land within a few per cent of the true 50,000.
    const error = Math.abs(result.crossoverUsd! - 50_000) / 50_000;
    assert.ok(error < 0.15, `crossover found at ${result.crossoverUsd}, expected near 50,000 (off by ${(error * 100).toFixed(1)}%)`);
    assert.match(result.verdict, /on-chain is cheaper up to about/);
  });

  test("more steps pin it tighter", async () => {
    const coarse = await findCrossover(crossingMarket(50_000), { symbol: "BNBUSDT", side: "BUY", steps: 3 });
    const fine = await findCrossover(crossingMarket(50_000), { symbol: "BNBUSDT", side: "BUY", steps: 12 });
    assert.ok(fine.precision < coarse.precision, `more probes should narrow the interval (${fine.precision} vs ${coarse.precision})`);
  });

  test("every probe is recorded, so the reading can be checked", async () => {
    const result = await findCrossover(crossingMarket(50_000), { symbol: "BNBUSDT", side: "BUY", steps: 5 });
    assert.ok(result.probes.length >= 5);
    for (const p of result.probes) {
      assert.ok(p.usd > 0);
      assert.equal(typeof p.onchainBps, "number");
      assert.equal(typeof p.binanceBps, "number");
    }
  });
});

describe("when they do not cross", () => {
  test("one venue winning throughout is reported as no crossover, not a guess", async () => {
    // The pool is cheaper at every size. Bisecting anyway would invent a number.
    const alwaysOnchain: Quoter = async () => ({
      mid: 100,
      routes: [route("BINANCE_SPOT", "TAKER", 10), route("ONCHAIN", "TAKER", 2)],
    });
    const result = await findCrossover(alwaysOnchain, { symbol: "BNBUSDT", side: "BUY" });
    assert.equal(result.crossoverUsd, null);
    assert.equal(result.cheapestWhenSmall, "on-chain");
    assert.equal(result.cheapestWhenLarge, "on-chain");
    assert.match(result.verdict, /cheaper at every size/);
  });

  test("the exchange winning throughout is reported the same way", async () => {
    // True of BTC and XRP today: the wallet fee puts on-chain behind at any size.
    const alwaysBinance: Quoter = async () => ({
      mid: 100,
      routes: [route("BINANCE_SPOT", "TAKER", 10), route("ONCHAIN", "TAKER", 60)],
    });
    const result = await findCrossover(alwaysBinance, { symbol: "BTCUSDT", side: "BUY" });
    assert.equal(result.crossoverUsd, null);
    assert.match(result.verdict, /Binance spot taker is cheaper at every size/);
  });
});

describe("when a venue cannot be priced", () => {
  test("an unpriceable end reports nothing to compare rather than a crossover", async () => {
    const halfPriced: Quoter = async (usd) => ({
      mid: 100,
      routes: [
        route("BINANCE_SPOT", "TAKER", 10),
        route("ONCHAIN", "TAKER", 0, usd > 1000 ? "no pool depth at this size" : undefined),
      ],
    });
    const result = await findCrossover(halfPriced, { symbol: "BNBUSDT", side: "BUY", minUsd: 5000, maxUsd: 500_000 });
    // Both ends price on Binance only, so the winner never changes: no crossing.
    assert.equal(result.crossoverUsd, null);
  });

  test("neither venue priceable is said plainly", async () => {
    const nothing: Quoter = async () => ({
      mid: 100,
      routes: [route("BINANCE_SPOT", "TAKER", 0, "book too thin"), route("ONCHAIN", "TAKER", 0, "no pool")],
    });
    const result = await findCrossover(nothing, { symbol: "BNBUSDT", side: "BUY" });
    assert.equal(result.crossoverUsd, null);
    assert.match(result.verdict, /nothing to compare/);
  });
});
