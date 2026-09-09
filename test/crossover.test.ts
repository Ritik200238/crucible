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

  test("a top the market will not price is brought down until it will", async () => {
    // The case that produced a false reading live: at $500,000 the book was too
    // thin to price the order at all, and the only route that answered was
    // on-chain. Rather than give up — or, worse, call the lone answer a winner —
    // the top of the range walks down until both venues quote.
    const probed: number[] = [];
    const thinAbove200k: Quoter = async (usd) => {
      probed.push(usd);
      return {
        mid: 100,
        routes: [
          route("BINANCE_SPOT", "TAKER", 10, usd > 200_000 ? "book too thin at this size" : undefined),
          route("ONCHAIN", "TAKER", 1 + (9 * usd) / 50_000),
        ],
      };
    };
    const result = await findCrossover(thinAbove200k, { symbol: "BNBUSDT", side: "BUY", minUsd: 100, maxUsd: 500_000 });

    assert.ok(probed.includes(500_000), "it has to try the range it was given first");
    assert.ok(
      probed.some((u) => u <= 200_000 && u > 100_000),
      `expected the top to be walked down, probed ${probed.join(", ")}`,
    );
    // Within the range that does price, the flip is still at 50,000.
    assert.ok(result.crossoverUsd !== null);
    assert.ok(Math.abs(result.crossoverUsd! - 50_000) / 50_000 < 0.15);
    assert.match(result.verdict, /nothing would price an order as large as/);
  });

  test("a lone answer is never reported as a venue winning", async () => {
    // Nothing prices on Binance above the smallest size, so bracketing cannot
    // rescue it. Reporting "on-chain is cheaper at every size" here would turn
    // a missing quote into a comparison nobody made.
    const binanceOnlyTiny: Quoter = async (usd) => ({
      mid: 100,
      routes: [
        route("BINANCE_SPOT", "TAKER", 10, usd > 150 ? "book too thin at this size" : undefined),
        route("ONCHAIN", "TAKER", 70),
      ],
    });
    const result = await findCrossover(binanceOnlyTiny, { symbol: "BNBUSDT", side: "BUY", minUsd: 100, maxUsd: 500_000 });

    assert.equal(result.crossoverUsd, null);
    assert.equal(result.cheapestWhenLarge, null, "an unpriced end has no winner");
    assert.doesNotMatch(
      result.verdict,
      /cheaper at every size/,
      "a venue standing alone must never be reported as having won",
    );
    assert.match(result.verdict, /could not price this order/);
    // The probe still carries what was read, so the gap is visible.
    const top = result.probes.find((p) => p.binanceBps === null)!;
    assert.equal(top.onchainBps, 70);
    assert.equal(top.edgeBps, null);
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
