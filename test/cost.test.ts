import { test } from "node:test";
import assert from "node:assert/strict";

import {
  costBinanceMaker,
  costBinanceTaker,
  costOnchain,
  fillProbability,
  priceAllRoutes,
  FILL_HORIZON_SEC,
} from "../src/cost/model.ts";
import type {
  BookLevel,
  CostComponent,
  CostEstimate,
  OnchainQuote,
  OnchainTierQuote,
  OrderBook,
  Side,
  Snapshot,
} from "../src/types.ts";

// BNBUSDT with a two-cent spread and ten levels of 5 BNB a side. Regular on
// purpose: every expected figure below is derived from these numbers by hand.
const MID = 752;
const BEST_BID = 751.99;
const BEST_ASK = 752.01;
const TICK = 0.01;
const LEVEL_QTY = 5;

// Half the spread against mid, in bps: 0.01 / 752 * 10000.
const HALF_SPREAD_BPS = (0.01 / MID) * 10_000;

// Gas beyond the quoter's own estimate, matching what quoteOnchain adds.
const GAS_OVERHEAD = 60_000;

// Carried through the quote untouched by the cost model; real addresses so the
// fixture is a quote shape rather than a stub.
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";

function closeTo(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

function component(estimate: CostEstimate, name: string): CostComponent {
  const found = estimate.components.find((c) => c.name === name);
  assert.ok(found, `no "${name}" component in ${estimate.components.map((c) => c.name).join(", ")}`);
  return found;
}

function sumOfComponents(estimate: CostEstimate): number {
  return estimate.components.reduce((a, c) => a + c.bps, 0);
}

function makeBook(shape: { levels?: number; qty?: number; spread?: number } = {}): OrderBook {
  const levels = shape.levels ?? 10;
  const qty = shape.qty ?? LEVEL_QTY;
  const half = (shape.spread ?? BEST_ASK - BEST_BID) / 2;
  const bids: BookLevel[] = [];
  const asks: BookLevel[] = [];
  for (let i = 0; i < levels; i++) {
    bids.push({ price: Number((MID - half - i * TICK).toFixed(2)), qty });
    asks.push({ price: Number((MID + half + i * TICK).toFixed(2)), qty });
  }
  return { bids, asks, lastUpdateId: 81_004_422 };
}

interface PoolOptions {
  side: Side;
  baseQty: number;
  /** Quote per base at negligible size, pool fee already inside it. */
  poolPrice?: number;
  /** Fractional worsening of the price per unit of the token going in. */
  slipPerUnitIn?: number;
  feeTier?: number;
  /** Drop the reference quote, as happens when the second quoter call fails. */
  withReference?: boolean;
}

/**
 * A pool quote built off a monotone price curve: the more goes in, the worse
 * the price comes back. That is the only property of the real quoter the cost
 * model leans on, and it is what makes impact against the reference size a
 * number that cannot come out negative.
 */
function makeOnchain(opts: PoolOptions): OnchainQuote {
  const buying = opts.side === "BUY";
  const poolPrice = opts.poolPrice ?? 752.5;
  const feeTier = opts.feeTier ?? 500;
  // The input is denominated in whichever token is going in, so the default
  // slope is scaled by price on a sell to keep the two sides comparable.
  const slip = opts.slipPerUnitIn ?? (buying ? 5e-8 : 5e-8 * MID);
  const amountIn = buying ? opts.baseQty * MID : opts.baseQty;

  /** Quote per base once an input of this size has pushed the pool. */
  const priceAt = (x: number) => (buying ? poolPrice * (1 + slip * x) : poolPrice * (1 - slip * x));
  const outFor = (x: number) => (buying ? x / priceAt(x) : x * priceAt(x));

  const tier = (fee: number, worseBy: number): OnchainTierQuote => {
    const amountOut = outFor(amountIn) * (1 - worseBy);
    return { feeTier: fee, amountOut, price: amountOut / amountIn, gasEstimate: 121_400 };
  };

  const best = tier(feeTier, 0);
  // quoteOnchain caps the reference at the real size, so an order smaller than
  // the reference reports zero impact rather than a negative one.
  const referenceIn = Math.min(amountIn, buying ? 10 : 10 / MID);
  const gasPriceWei = 1_000_000_000;

  return {
    chainId: 56,
    tokenIn: buying ? USDT_BSC : WBNB,
    tokenOut: buying ? WBNB : USDT_BSC,
    amountIn,
    tiers: [best, tier(2500, 0.0017)],
    best,
    gasPriceWei,
    gasCostUsd: (((best.gasEstimate + GAS_OVERHEAD) * gasPriceWei) / 1e18) * MID,
    referencePrice: opts.withReference === false ? null : outFor(referenceIn) / referenceIn,
    walletQuote: null,
  };
}

function makeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    symbol: "BNBUSDT",
    takenAt: 1_757_337_600_000,
    mid: MID,
    bestBid: BEST_BID,
    bestAsk: BEST_ASK,
    spreadBps: ((BEST_ASK - BEST_BID) / MID) * 10_000,
    book: makeBook(),
    filters: {
      symbol: "BNBUSDT",
      baseAsset: "BNB",
      quoteAsset: "USDT",
      baseAssetPrecision: 8,
      quoteAssetPrecision: 8,
      stepSize: 0.001,
      minQty: 0.001,
      maxQty: 9000,
      tickSize: 0.01,
      minNotional: 5,
    },
    commission: { maker: 0.001, taker: 0.001, source: "vip0-default" },
    flow: { hitsBidPerSec: 3, liftsAskPerSec: 3, windowSec: 60 },
    onchain: null,
    hash: "1f0a7c4b2e9d6538",
    ...over,
  };
}

/** A snapshot whose on-chain leg is priced for exactly the size being routed. */
function pricedFor(side: Side, baseQty: number, pool: Partial<PoolOptions> = {}): Snapshot {
  return makeSnapshot({ onchain: makeOnchain({ side, baseQty, ...pool }) });
}

// ---------------------------------------------------------------------------
// costBinanceTaker
// ---------------------------------------------------------------------------

test("costBinanceTaker totals exactly the components it lists", () => {
  for (const side of ["BUY", "SELL"] as const) {
    const estimate = costBinanceTaker({ snapshot: makeSnapshot(), side, baseQty: 12 });

    assert.equal(estimate.components.length, 3);
    assert.equal(sumOfComponents(estimate), estimate.totalBps);
  }
});

test("costBinanceTaker charges the account's taker commission in bps", () => {
  const vip0 = costBinanceTaker({ snapshot: makeSnapshot(), side: "BUY", baseQty: 5 });
  assert.equal(component(vip0, "taker fee").bps, 10);
  assert.equal(component(vip0, "taker fee").estimated, true);

  const real = costBinanceTaker({
    snapshot: makeSnapshot({ commission: { maker: 0.0002, taker: 0.00045, source: "account" } }),
    side: "BUY",
    baseQty: 5,
  });
  assert.equal(component(real, "taker fee").bps, 4.5);
  // A rate read from the account is measured, not modelled.
  assert.equal(component(real, "taker fee").estimated, false);
});

test("costBinanceTaker charges half the spread on both sides", () => {
  const buy = costBinanceTaker({ snapshot: makeSnapshot(), side: "BUY", baseQty: 5 });
  const sell = costBinanceTaker({ snapshot: makeSnapshot(), side: "SELL", baseQty: 5 });

  // Reaching the touch costs the same whichever way you cross a symmetric book.
  closeTo(component(buy, "half spread").bps, HALF_SPREAD_BPS);
  closeTo(component(sell, "half spread").bps, HALF_SPREAD_BPS);
  assert.ok(component(buy, "half spread").bps > 0);
  assert.ok(component(sell, "half spread").bps > 0);
});

test("costBinanceTaker charges no impact for an order that fits on the touch", () => {
  // Five BNB is exactly what rests at 752.01, so the average fill is the touch
  // and the impact is not approximately zero but zero.
  const estimate = costBinanceTaker({ snapshot: makeSnapshot(), side: "BUY", baseQty: LEVEL_QTY });
  const impact = component(estimate, "book impact");

  assert.equal(impact.bps, 0);
  assert.match(impact.detail, /fits on the touch/);
});

test("costBinanceTaker charges impact for an order that eats past the touch", () => {
  // 12 BNB averages 752.0175, which is 0.2327 bps above mid; take off the
  // 0.1330 bps of half spread and 0.0997 bps of impact is left.
  const estimate = costBinanceTaker({ snapshot: makeSnapshot(), side: "BUY", baseQty: 12 });
  const impact = component(estimate, "book impact");

  closeTo(impact.bps, ((752.0175 - MID) / MID) * 10_000 - HALF_SPREAD_BPS, 1e-9);
  assert.ok(impact.bps > 0);
  assert.match(impact.detail, /Eating 3 levels/);
});

test("costBinanceTaker grows with size", () => {
  const at = (baseQty: number) =>
    costBinanceTaker({ snapshot: makeSnapshot(), side: "BUY", baseQty }).totalBps;

  assert.ok(at(5) < at(12));
  assert.ok(at(12) < at(30));
});

test("costBinanceTaker refuses to price a size the visible book cannot fill", () => {
  // Ten levels of 5 BNB is 50 in total.
  const estimate = costBinanceTaker({ snapshot: makeSnapshot(), side: "BUY", baseQty: 100 });

  assert.ok(estimate.unavailable, "an order past the visible book has no honest price");
  assert.match(estimate.unavailable, /only 50\.000000 of the 100\.000000 needed/);
  assert.equal(estimate.totalBps, Infinity);
  assert.deepEqual(estimate.components, []);
  assert.equal(estimate.hasEstimates, false);
});

test("costBinanceTaker moves the effective price against the side being traded", () => {
  const buy = costBinanceTaker({ snapshot: makeSnapshot(), side: "BUY", baseQty: 12 });
  const sell = costBinanceTaker({ snapshot: makeSnapshot(), side: "SELL", baseQty: 12 });

  assert.ok(buy.effectivePrice > MID, "a buy pays above mid");
  assert.ok(sell.effectivePrice < MID, "a sell receives below mid");
  closeTo(buy.totalUsd, (buy.totalBps / 10_000) * 12 * MID);
});

// ---------------------------------------------------------------------------
// fillProbability
// ---------------------------------------------------------------------------

test("fillProbability falls as the order grows", () => {
  // 0.4 BNB/s of sellers over the 60s horizon is 24 BNB of flow, against a
  // queue of 5 plus the order itself.
  const snapshot = makeSnapshot({ flow: { hitsBidPerSec: 0.4, liftsAskPerSec: 0.4, windowSec: 60 } });
  const sizes = [4, 8, 16, 32, 64];

  const ps = sizes.map((q) => fillProbability(snapshot, "BUY", q));
  for (let i = 1; i < ps.length; i++) {
    assert.ok(
      ps[i]! < ps[i - 1]!,
      `${sizes[i]} BNB should be less likely to fill than ${sizes[i - 1]}: ${ps[i]} against ${ps[i - 1]}`,
    );
  }
  // None of these are at the cap, so the ordering is the model talking.
  assert.ok(ps[0]! < 0.95);
});

test("fillProbability is zero when nothing is arriving on that side", () => {
  const oneSided = makeSnapshot({ flow: { hitsBidPerSec: 0, liftsAskPerSec: 3, windowSec: 60 } });

  assert.equal(fillProbability(oneSided, "BUY", 5), 0);
  assert.ok(fillProbability(oneSided, "SELL", 5) > 0, "the other side is still trading");
  assert.equal(fillProbability(makeSnapshot({ flow: { hitsBidPerSec: 0, liftsAskPerSec: 0, windowSec: 60 } }), "SELL", 5), 0);
});

test("fillProbability reads hits into the bid for a BUY and lifts of the ask for a SELL", () => {
  // Both sides of the book hold 5 BNB at the touch, so the only thing that can
  // separate these two numbers is which flow rate was used.
  const snapshot = makeSnapshot({ flow: { hitsBidPerSec: 0.2, liftsAskPerSec: 0.6, windowSec: 60 } });

  const buy = fillProbability(snapshot, "BUY", 10);
  const sell = fillProbability(snapshot, "SELL", 10);

  closeTo(buy, 1 - Math.exp(-(0.2 * FILL_HORIZON_SEC) / 15), 1e-12);
  closeTo(sell, 1 - Math.exp(-(0.6 * FILL_HORIZON_SEC) / 15), 1e-12);
  assert.ok(buy < sell, `slower flow into the bid should fill less often: ${buy} against ${sell}`);
});

test("fillProbability never claims better than a 95% chance", () => {
  // 180 BNB of flow against a queue of 6 is certainty as far as the maths goes.
  assert.equal(fillProbability(makeSnapshot(), "BUY", 1), 0.95);
  assert.equal(fillProbability(makeSnapshot({ flow: { hitsBidPerSec: 500, liftsAskPerSec: 500, windowSec: 60 } }), "BUY", 40), 0.95);
});

// ---------------------------------------------------------------------------
// costBinanceMaker
// ---------------------------------------------------------------------------

test("costBinanceMaker totals exactly the components it lists", () => {
  for (const side of ["BUY", "SELL"] as const) {
    const estimate = costBinanceMaker({ snapshot: makeSnapshot(), side, baseQty: 12 });

    assert.equal(estimate.components.length, 3);
    assert.equal(sumOfComponents(estimate), estimate.totalBps);
  }
});

test("costBinanceMaker is marked as estimated in every component", () => {
  const estimate = costBinanceMaker({ snapshot: makeSnapshot(), side: "BUY", baseQty: 12 });

  assert.equal(estimate.hasEstimates, true);
  for (const c of estimate.components) {
    assert.equal(c.estimated, true, `${c.name} is modelled, not measured`);
  }
});

test("costBinanceMaker weights the post against the cost of missing it", () => {
  const snapshot = makeSnapshot({ flow: { hitsBidPerSec: 0.4, liftsAskPerSec: 0.4, windowSec: 60 } });
  const input = { snapshot, side: "BUY" as const, baseQty: 12 };

  const p = fillProbability(snapshot, "BUY", 12);
  const crossing = costBinanceTaker(input).totalBps;
  const maker = costBinanceMaker(input);

  assert.ok(p > 0 && p < 0.95, `the fixture should leave real doubt about filling, got ${p}`);
  // Fee and earned spread only happen if it fills; crossing later only happens
  // if it does not.
  closeTo(maker.totalBps, p * (10 - HALF_SPREAD_BPS) + (1 - p) * crossing, 1e-9);
  closeTo(component(maker, "maker fee").bps, 10 * p, 1e-9);
  closeTo(component(maker, "spread earned").bps, -HALF_SPREAD_BPS * p, 1e-9);
  closeTo(component(maker, "unfilled fallback").bps, crossing * (1 - p), 1e-9);
});

test("costBinanceMaker refuses when the crossing fallback cannot be priced", () => {
  const estimate = costBinanceMaker({ snapshot: makeSnapshot(), side: "BUY", baseQty: 100 });

  assert.ok(estimate.unavailable);
  assert.match(estimate.unavailable, /^Cannot price the fallback for an unfilled post/);
  assert.equal(estimate.totalBps, Infinity);
});

// ---------------------------------------------------------------------------
// costOnchain
// ---------------------------------------------------------------------------

test("costOnchain totals exactly the components it lists", () => {
  for (const side of ["BUY", "SELL"] as const) {
    const estimate = costOnchain({ snapshot: pricedFor(side, 10), side, baseQty: 10 });

    assert.equal(estimate.components.length, 5);
    assert.equal(sumOfComponents(estimate), estimate.totalBps);
  }
});

test("costOnchain reports the pool fee of the tier that answered best", () => {
  const at2500 = costOnchain({
    snapshot: pricedFor("BUY", 10, { feeTier: 2500 }),
    side: "BUY",
    baseQty: 10,
  });

  assert.equal(component(at2500, "pool fee").bps, 25);
  assert.match(component(at2500, "pool fee").detail, /0\.25% tier/);
});

test("costOnchain never reports negative impact at or above the reference size", () => {
  // The reference is $10 of input, so anything from 0.0133 BNB up is at or past
  // it. Impact measured against a price taken further down the same curve could
  // only come out negative if the fee were being subtracted twice.
  const reference = 10 / MID;

  for (const side of ["BUY", "SELL"] as const) {
    for (const baseQty of [reference, 0.05, 0.5, 5, 10, 50]) {
      const estimate = costOnchain({ snapshot: pricedFor(side, baseQty), side, baseQty });
      const impact = component(estimate, "price impact").bps;

      assert.ok(impact >= -1e-9, `${side} ${baseQty} BNB gave ${impact} bps of impact`);
    }
  }

  // And it is a real number, not a rounding artefact, once the size bites.
  const big = costOnchain({ snapshot: pricedFor("BUY", 50), side: "BUY", baseQty: 50 });
  assert.ok(component(big, "price impact").bps > 1);
});

test("costOnchain separates the pool's own move from the gap to Binance", () => {
  const baseQty = 10;
  const snapshot = pricedFor("BUY", baseQty, { poolPrice: 752.5 });
  const estimate = costOnchain({ snapshot, side: "BUY", baseQty });

  // The pool's own mid, taken at the reference size, is 752.5004 against a
  // Binance mid of 752: a 6.65 bps venue gap. The 5 bps pool fee is already
  // inside that price, so 1.65 bps of divergence is what is left.
  const poolMid = 1 / snapshot.onchain!.referencePrice!;
  closeTo(component(estimate, "venue divergence").bps, ((poolMid - MID) / MID) * 10_000 - 5, 1e-9);
  closeTo(component(estimate, "venue divergence").bps, 1.6539, 1e-4);
  assert.match(component(estimate, "price impact").detail, /pushes the pool past its own mid/);
});

test("costOnchain reports impact and divergence together when the reference is missing", () => {
  const baseQty = 10;
  const withReference = costOnchain({
    snapshot: pricedFor("BUY", baseQty),
    side: "BUY",
    baseQty,
  });
  const without = costOnchain({
    snapshot: pricedFor("BUY", baseQty, { withReference: false }),
    side: "BUY",
    baseQty,
  });

  assert.equal(without.components.length, 4);
  assert.equal(component(without, "impact and divergence").estimated, true);
  assert.equal(without.hasEstimates, true);
  assert.equal(withReference.hasEstimates, false);

  // Splitting the remainder is presentation. The total comes from the quoter
  // either way and must not move.
  closeTo(without.totalBps, withReference.totalBps, 1e-9);
  closeTo(
    component(without, "impact and divergence").bps,
    component(withReference, "venue divergence").bps + component(withReference, "price impact").bps,
    1e-9,
  );
});

test("costOnchain spreads the gas cost over the notional", () => {
  const baseQty = 10;
  const snapshot = pricedFor("BUY", baseQty);
  const estimate = costOnchain({ snapshot, side: "BUY", baseQty });

  const gasUsd = snapshot.onchain!.gasCostUsd;
  closeTo(component(estimate, "gas").bps, (gasUsd / (baseQty * MID)) * 10_000, 1e-9);

  // The same gas over ten times the notional is a tenth of the cost in bps.
  const larger = costOnchain({ snapshot: pricedFor("BUY", 100), side: "BUY", baseQty: 100 });
  assert.ok(component(larger, "gas").bps < component(estimate, "gas").bps);
});

test("costOnchain charges no wallet service fee to swap BNB against USDT", () => {
  const estimate = costOnchain({ snapshot: pricedFor("BUY", 10), side: "BUY", baseQty: 10 });
  const fee = component(estimate, "wallet service fee");

  assert.equal(fee.bps, 0);
  assert.match(fee.detail, /both major assets/);
});

test("costOnchain charges 50 bps when an asset sits outside the major group", () => {
  const snapshot = pricedFor("BUY", 10);
  const outsider = {
    ...snapshot,
    filters: { ...snapshot.filters, symbol: "CAKEUSDT", baseAsset: "CAKE" },
  };

  const fee = component(costOnchain({ snapshot: outsider, side: "BUY", baseQty: 10 }), "wallet service fee");
  assert.equal(fee.bps, 50);
  assert.match(fee.detail, /0\.50% charged/);
});

test("costOnchain passes through the reason the on-chain leg is missing", () => {
  const rpcDown = makeSnapshot({
    onchain: null,
    onchainUnavailable: "Every BSC RPC failed for eth_gasPrice. Last error — timed out",
  });

  const estimate = costOnchain({ snapshot: rpcDown, side: "BUY", baseQty: 10 });
  assert.equal(estimate.unavailable, rpcDown.onchainUnavailable);
  assert.equal(estimate.totalBps, Infinity);
  assert.equal(estimate.venue, "ONCHAIN");
});

test("costOnchain says so plainly when no quote was taken at all", () => {
  const estimate = costOnchain({ snapshot: makeSnapshot(), side: "BUY", baseQty: 10 });

  assert.equal(estimate.unavailable, "No on-chain quote was taken.");
});

test("costOnchain refuses when the quote came back with no usable tier", () => {
  const noPool = makeSnapshot({ onchain: { ...makeOnchain({ side: "BUY", baseQty: 10 }), best: null } });

  const estimate = costOnchain({ snapshot: noPool, side: "BUY", baseQty: 10 });
  assert.equal(estimate.unavailable, "No pool answered for this pair at this size.");
});

// ---------------------------------------------------------------------------
// priceAllRoutes
// ---------------------------------------------------------------------------

test("priceAllRoutes prices all three routes, including the ones that cannot be used", () => {
  const priced = priceAllRoutes({ snapshot: pricedFor("BUY", 10), side: "BUY", baseQty: 10 });

  assert.deepEqual(
    priced.map((r) => `${r.venue}/${r.style}`),
    ["BINANCE_SPOT/TAKER", "BINANCE_SPOT/MAKER", "ONCHAIN/TAKER"],
  );
  assert.equal(priced.filter((r) => r.unavailable).length, 0);

  // A route that cannot be filled is kept with its reason rather than dropped.
  const tooBig = priceAllRoutes({ snapshot: makeSnapshot(), side: "BUY", baseQty: 100 });
  assert.equal(tooBig.length, 3);
  assert.equal(tooBig.filter((r) => r.unavailable).length, 3);
});
