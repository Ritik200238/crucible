import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertExecutable,
  hashPolicy,
  measuredImpactBps,
  planSlices,
  resolveQty,
  route,
  PLAN_TTL_MS,
  RouteError,
} from "../src/decide/router.ts";
import { costBinanceTaker } from "../src/cost/model.ts";
import { DEFAULT_POLICY } from "../src/config.ts";
import type {
  BookLevel,
  Intent,
  OnchainQuote,
  OnchainTierQuote,
  OrderBook,
  Policy,
  Side,
  Snapshot,
} from "../src/types.ts";

// BNBUSDT with a two-cent spread and ten levels of 5 BNB a side: 50 BNB of
// visible depth, which is the ceiling every "too big" case below leans on.
const MID = 752;
const BEST_BID = 751.99;
const BEST_ASK = 752.01;
const TICK = 0.01;
const LEVEL_QTY = 5;
const STEP = 0.001;
const TAKEN_AT = 1_757_337_600_000;

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";

function closeTo(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
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

/**
 * A pool quote off a monotone price curve, priced for one exact size. Only
 * `poolPrice` matters to these tests: it is the lever that decides whether the
 * on-chain route is worth taking.
 */
function makeOnchain(side: Side, baseQty: number, poolPrice = 752.5): OnchainQuote {
  const buying = side === "BUY";
  const slip = buying ? 5e-8 : 5e-8 * MID;
  const amountIn = buying ? baseQty * MID : baseQty;
  const priceAt = (x: number) => (buying ? poolPrice * (1 + slip * x) : poolPrice * (1 - slip * x));
  const outFor = (x: number) => (buying ? x / priceAt(x) : x * priceAt(x));

  const tier = (fee: number, worseBy: number): OnchainTierQuote => {
    const amountOut = outFor(amountIn) * (1 - worseBy);
    return { feeTier: fee, amountOut, price: amountOut / amountIn, gasEstimate: 121_400 };
  };
  const best = tier(500, 0);
  const referenceIn = Math.min(amountIn, buying ? 10 : 10 / MID);

  return {
    chainId: 56,
    tokenIn: buying ? USDT_BSC : WBNB,
    tokenOut: buying ? WBNB : USDT_BSC,
    amountIn,
    tiers: [best, tier(2500, 0.0017)],
    best,
    gasPriceWei: 1_000_000_000,
    gasCostUsd: 0.1364,
    referencePrice: outFor(referenceIn) / referenceIn,
    walletQuote: null,
  };
}

function makeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    symbol: "BNBUSDT",
    takenAt: TAKEN_AT,
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
      stepSize: STEP,
      minQty: 0.001,
      maxQty: 9000,
      tickSize: TICK,
      minNotional: 5,
    },
    // Read from the account, so the Binance taker route carries no modelled
    // component and the estimate handicap can be tested deliberately.
    commission: { maker: 0.001, taker: 0.001, source: "account" },
    flow: { hitsBidPerSec: 3, liftsAskPerSec: 3, windowSec: 60 },
    onchain: null,
    hash: "1f0a7c4b2e9d6538",
    ...over,
  };
}

/** The pool priced below the Binance mid, so the on-chain route wins outright. */
function onchainCheaper(baseQty = 10): Snapshot {
  return makeSnapshot({ onchain: makeOnchain("BUY", baseQty, 751.9) });
}

/** The pool priced well above mid, so Binance wins outright. */
function onchainDearer(baseQty = 10): Snapshot {
  return makeSnapshot({ onchain: makeOnchain("BUY", baseQty, 753.5) });
}

const policy = (over: Partial<Policy> = {}): Policy => ({ version: 1, mode: "dry-run", ...over });

const buy = (over: Partial<Intent> = {}): Intent => ({
  symbol: "BNBUSDT",
  side: "BUY",
  baseQty: 10,
  ...over,
});

// ---------------------------------------------------------------------------
// resolveQty
// ---------------------------------------------------------------------------

test("resolveQty turns a quote size into a base size at the snapshot mid", () => {
  assert.equal(resolveQty({ symbol: "BNBUSDT", side: "BUY", quoteQty: 7520 }, makeSnapshot()), 10);

  // The same dollars against a higher mid buy less.
  const richer = makeSnapshot({ mid: 940 });
  assert.equal(resolveQty({ symbol: "BNBUSDT", side: "BUY", quoteQty: 7520 }, richer), 8);
});

test("resolveQty passes a base size through untouched when it already fits the step", () => {
  assert.equal(resolveQty(buy({ baseQty: 2.5 }), makeSnapshot()), 2.5);
});

test("resolveQty rounds down to the step, never up", () => {
  // Rounding up produces an order the exchange rejects outright.
  assert.equal(resolveQty(buy({ baseQty: 1.23456 }), makeSnapshot()), 1.234);
  assert.equal(resolveQty(buy({ baseQty: 1.2349 }), makeSnapshot()), 1.234);
  assert.equal(resolveQty({ symbol: "BNBUSDT", side: "BUY", quoteQty: 500 }, makeSnapshot()), 0.664);
});

test("resolveQty refuses a size that rounds away to nothing", () => {
  assert.throws(
    () => resolveQty(buy({ baseQty: 0.0004 }), makeSnapshot()),
    (err: unknown) => {
      assert.ok(err instanceof RouteError);
      assert.match(err.message, /rounds to zero against BNBUSDT's step of 0\.001/);
      assert.match(err.message, /smallest tradeable amount is 0\.001/);
      return true;
    },
  );
});

test("resolveQty refuses an order worth less than the symbol's minimum", () => {
  // 0.001 BNB is on the step but only $0.75, under the $5 NOTIONAL filter.
  assert.throws(
    () => resolveQty(buy({ baseQty: 0.001 }), makeSnapshot()),
    /\$0\.75 is below BNBUSDT's minimum order value of \$5/,
  );

  // A symbol with no notional filter lets the same size through.
  const noMinimum = makeSnapshot({ filters: { ...makeSnapshot().filters, minNotional: 0 } });
  assert.equal(resolveQty(buy({ baseQty: 0.001 }), noMinimum), 0.001);
});

test("resolveQty refuses an intent that names no size at all", () => {
  assert.throws(
    () => resolveQty({ symbol: "BNBUSDT", side: "BUY" }, makeSnapshot()),
    /Specify exactly one of baseQty or quoteQty, greater than zero/,
  );
  assert.throws(() => resolveQty(buy({ baseQty: 0 }), makeSnapshot()), RouteError);
  assert.throws(() => resolveQty(buy({ baseQty: -5 }), makeSnapshot()), RouteError);
  assert.throws(
    () => resolveQty({ symbol: "BNBUSDT", side: "BUY", quoteQty: 0 }, makeSnapshot()),
    RouteError,
  );
});

test("resolveQty refuses an intent that carries both sizes", () => {
  // Both set is a contradiction. Silently preferring one would leave the other
  // in the plan and the receipt, so the record would show a size never traded.
  assert.throws(
    () => resolveQty({ symbol: "BNBUSDT", side: "BUY", baseQty: 1, quoteQty: 5000 }, makeSnapshot()),
    /both/i,
  );
});
test("route takes the cheapest route available", () => {
  const cheapPool = route({ intent: buy(), snapshot: onchainCheaper(), policy: policy() });
  assert.equal(cheapPool.chosen.venue, "ONCHAIN");
  assert.ok(
    cheapPool.chosen.totalBps < cheapPool.alternatives[0]!.totalBps,
    "the chosen route must be cheaper than the best rejected one",
  );

  const dearPool = route({ intent: buy(), snapshot: onchainDearer(), policy: policy() });
  assert.equal(dearPool.chosen.venue, "BINANCE_SPOT");
  assert.equal(dearPool.alternatives.some((r) => r.venue === "ONCHAIN"), true);
});

test("route reports the saving against the best route it rejected", () => {
  const plan = route({ intent: buy(), snapshot: onchainCheaper(), policy: policy() });

  assert.equal(plan.savingBps, plan.alternatives[0]!.totalBps - plan.chosen.totalBps);
  assert.ok(plan.savingBps > 0);
  closeTo(plan.savingUsd, (plan.savingBps / 10_000) * plan.quoteQty);
  assert.match(plan.rationale, /on-chain at .* bps beats Binance spot/);
});

test("route drops a venue the policy does not allow, whatever it costs", () => {
  const snapshot = onchainCheaper();
  const binanceOnly = route({
    intent: buy(),
    snapshot,
    policy: policy({ venueAllowlist: ["BINANCE_SPOT"] }),
  });

  assert.equal(binanceOnly.chosen.venue, "BINANCE_SPOT");
  assert.equal(binanceOnly.alternatives.some((r) => r.venue === "ONCHAIN"), false);

  // The same snapshot without the allowlist takes the pool, so the allowlist is
  // what changed the answer rather than the price.
  assert.equal(route({ intent: buy(), snapshot, policy: policy() }).chosen.venue, "ONCHAIN");

  const poolOnly = route({
    intent: buy(),
    snapshot,
    policy: policy({ venueAllowlist: ["ONCHAIN"] }),
  });
  assert.equal(poolOnly.chosen.venue, "ONCHAIN");
  assert.equal(poolOnly.alternatives.length, 0);
});

test("route refuses, with every reason, when nothing can fill the order", () => {
  assert.throws(
    () =>
      route({
        intent: buy(),
        snapshot: makeSnapshot(),
        policy: policy({ venueAllowlist: ["ONCHAIN"] }),
      }),
    (err: unknown) => {
      assert.ok(err instanceof RouteError);
      assert.match(err.message, /No route can fill this order/);
      assert.match(err.message, /BINANCE_SPOT\/TAKER: BINANCE_SPOT is not in your venue allowlist/);
      assert.match(err.message, /ONCHAIN\/TAKER: No on-chain quote was taken/);
      return true;
    },
  );

  // A size past the visible book with no pool leaves nothing either.
  assert.throws(
    () => route({ intent: buy({ baseQty: 100 }), snapshot: makeSnapshot(), policy: policy() }),
    /No route can fill this order/,
  );
});

test("route fingerprints the same decision the same way every time", () => {
  const snapshot = onchainCheaper();
  const first = route({ intent: buy(), snapshot, policy: policy() });
  const second = route({ intent: buy(), snapshot, policy: policy() });

  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.id, second.id);
  assert.match(first.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(first.id, first.fingerprint.slice(0, 12));

  // The clock is the only thing that may differ between two identical plans.
  const later = route({ intent: buy(), snapshot, policy: policy(), now: TAKEN_AT + 5_000 });
  assert.equal(later.fingerprint, first.fingerprint);
  assert.equal(later.createdAt, TAKEN_AT + 5_000);
  assert.equal(later.expiresAt, TAKEN_AT + 5_000 + PLAN_TTL_MS);
});

test("route fingerprints change when the size, the market or the policy changes", () => {
  const snapshot = onchainCheaper();
  const base = route({ intent: buy(), snapshot, policy: policy() }).fingerprint;

  const bigger = route({ intent: buy({ baseQty: 20 }), snapshot, policy: policy() });
  assert.notEqual(bigger.fingerprint, base, "a different size is a different decision");

  const restated = route({
    intent: { symbol: "BNBUSDT", side: "BUY", quoteQty: 7520 },
    snapshot,
    policy: policy(),
  });
  assert.equal(restated.fingerprint, base, "the same size stated in dollars is the same decision");

  const moved = route({ intent: buy(), snapshot: { ...snapshot, hash: "0000000000000000" }, policy: policy() });
  assert.notEqual(moved.fingerprint, base, "a different market is a different decision");

  const stricter = route({ intent: buy(), snapshot, policy: policy({ maxSlippageBps: 20 }) });
  assert.notEqual(stricter.fingerprint, base, "a different policy is a different decision");
});

test("route keeps a measured route over an estimated one that barely beats it", () => {
  // Posting saves the half spread and costs the chance of not filling. On a
  // two-cent spread that is a fraction of a bp either way, which is well inside
  // the error of guessing whether the order fills at all.
  const plan = route({ intent: buy(), snapshot: makeSnapshot(), policy: policy() });
  const rejected = plan.alternatives[0]!;

  assert.equal(plan.chosen.style, "TAKER");
  assert.equal(plan.chosen.hasEstimates, false);
  assert.equal(rejected.style, "MAKER");
  assert.ok(rejected.totalBps < plan.chosen.totalBps, "the rejected route really was cheaper");
  assert.ok(plan.chosen.totalBps - rejected.totalBps < 1, "and it lost by less than a basis point");

  // The plan records what that cost, rather than reporting a saving it did not make.
  assert.ok(plan.savingBps < 0);
  assert.match(plan.rationale, /taken on measured rather than modelled cost/);
});

test("route takes the estimated route when it wins by more than a basis point", () => {
  // A two-dollar spread makes posting worth 25 bps, far past anything the fill
  // model could be wrong by.
  const wide = makeSnapshot({ book: makeBook({ spread: 2 }), bestBid: 751, bestAsk: 753 });
  const plan = route({ intent: buy(), snapshot: wide, policy: policy() });

  assert.equal(plan.chosen.style, "MAKER");
  assert.equal(plan.chosen.hasEstimates, true);
  assert.ok(plan.savingBps > 1);
  assert.match(plan.rationale, /Some components of this route are modelled/);
});

test("route slices a Binance order that moves the book past the impact cap", () => {
  // 40 BNB against 5 a level walks eight levels; a 0.1 bps cap is far below
  // what that costs, so the order has to be split.
  const plan = route({
    intent: buy({ baseQty: 40 }),
    snapshot: makeSnapshot(),
    policy: policy({ maxImpactBps: 0.1 }),
  });

  assert.equal(plan.chosen.venue, "BINANCE_SPOT");
  assert.equal(plan.chosen.style, "SLICED");
  assert.ok(plan.slices.length > 1);
  assert.equal(plan.slices.reduce((a, s) => a + s.baseQty, 0), 40);
  assert.match(plan.rationale, /Split into \d+ children/);

  // Under a normal cap the same order goes out in one piece.
  const whole = route({
    intent: buy({ baseQty: 40 }),
    snapshot: makeSnapshot(),
    policy: policy({ maxImpactBps: 25 }),
  });
  assert.deepEqual(whole.slices, []);
  assert.equal(whole.chosen.style, "TAKER");
});

test("route fills in the sizes and the snapshot the plan was made from", () => {
  const snapshot = onchainCheaper();
  const plan = route({ intent: buy({ baseQty: 12.3456 }), snapshot, policy: policy() });

  assert.equal(plan.baseQty, 12.345);
  closeTo(plan.quoteQty, 12.345 * MID);
  assert.equal(plan.snapshotHash, snapshot.hash);
  assert.equal(plan.createdAt, TAKEN_AT);
  assert.equal(plan.expiresAt, TAKEN_AT + PLAN_TTL_MS);
  assert.deepEqual(plan.intent, { symbol: "BNBUSDT", side: "BUY", baseQty: 12.3456 });
});

// ---------------------------------------------------------------------------
// planSlices
// ---------------------------------------------------------------------------

test("planSlices leaves an order alone when its impact is inside the cap", () => {
  assert.deepEqual(planSlices(10, 5, policy({ maxImpactBps: 25 }), STEP), []);
  assert.deepEqual(planSlices(10, 25, policy({ maxImpactBps: 25 }), STEP), []);
  // No cap configured is not a cap of zero.
  assert.deepEqual(planSlices(10, 500, policy(), STEP), []);
});

test("planSlices splits into as many children as the breach calls for", () => {
  // 60 bps against a 25 bps cap wants three children; 30 against 25 wants two,
  // which is also the floor.
  assert.equal(planSlices(10, 60, policy({ maxImpactBps: 25 }), STEP).length, 3);
  assert.equal(planSlices(10, 30, policy({ maxImpactBps: 25 }), STEP).length, 2);
  assert.equal(planSlices(10, 25.1, policy({ maxImpactBps: 25 }), STEP).length, 2);
});

test("planSlices spaces the children out and numbers them in order", () => {
  const slices = planSlices(10, 60, policy({ maxImpactBps: 25 }), STEP);

  assert.deepEqual(
    slices.map((s) => [s.index, s.offsetMs]),
    [
      [0, 0],
      [1, 30_000],
      [2, 60_000],
    ],
  );
});

test("planSlices hands the whole order out across its children", () => {
  const clean = planSlices(10, 60, policy({ maxImpactBps: 25 }), STEP);
  assert.deepEqual(clean.map((s) => s.baseQty), [3.333, 3.333, 3.334]);
  assert.equal(clean.reduce((a, s) => a + s.baseQty, 0), 10);

  const awkward = planSlices(13.777, 80, policy({ maxImpactBps: 25 }), STEP);
  // The last child carries the remainder, normalised to eight decimals, which
  // is finer than any quantity Binance accepts.
  assert.equal(Number(awkward.reduce((a, s) => a + s.baseQty, 0).toFixed(8)), 13.777);
  assert.deepEqual(awkward.map((s) => s.baseQty), [3.444, 3.444, 3.444, 3.445]);
});

test("planSlices keeps every child on the symbol's step size", () => {
  for (const [total, impact] of [
    [10, 60],
    [13.777, 80],
    [7, 60],
  ] as const) {
    for (const slice of planSlices(total, impact, policy({ maxImpactBps: 25 }), STEP)) {
      const steps = slice.baseQty / STEP;
      assert.ok(
        Math.abs(steps - Math.round(steps)) < 1e-6,
        `${slice.baseQty} is not a whole number of ${STEP} steps`,
      );
    }
  }
});

test("planSlices never proposes more than ten children", () => {
  // 1000 bps against a 25 bps cap asks for forty; ten is the ceiling.
  const slices = planSlices(10, 1000, policy({ maxImpactBps: 25 }), STEP);

  assert.equal(slices.length, 10);
  assert.equal(slices.reduce((a, s) => a + s.baseQty, 0), 10);
  assert.equal(slices[9]!.offsetMs, 270_000);
});

test("planSlices declines to split an order smaller than its own children", () => {
  // A tenth of 0.005 BNB rounds to nothing on a 0.001 step, so there is no
  // split to make and the order stays whole.
  assert.deepEqual(planSlices(0.005, 1000, policy({ maxImpactBps: 25 }), STEP), []);
});

// ---------------------------------------------------------------------------
// assertExecutable
// ---------------------------------------------------------------------------

test("assertExecutable lets a plan through up to the moment it expires", () => {
  const plan = route({ intent: buy(), snapshot: onchainCheaper(), policy: policy() });

  assert.doesNotThrow(() => assertExecutable(plan, plan.createdAt));
  assert.doesNotThrow(() => assertExecutable(plan, plan.createdAt + 30_000));
  assert.doesNotThrow(() => assertExecutable(plan, plan.expiresAt));

  // Freshly made against the real clock, the default now is inside the window.
  const fresh = route({
    intent: buy(),
    snapshot: onchainCheaper(),
    policy: policy(),
    now: Date.now(),
  });
  assert.doesNotThrow(() => assertExecutable(fresh));
});

test("assertExecutable refuses a stale plan and names it", () => {
  const plan = route({ intent: buy(), snapshot: onchainCheaper(), policy: policy() });

  assert.throws(
    () => assertExecutable(plan, plan.expiresAt + 90_000),
    (err: unknown) => {
      assert.ok(err instanceof RouteError);
      assert.match(err.message, new RegExp(`^Plan ${plan.id} expired 90s ago \\(created 150s ago\\)`));
      assert.match(err.message, /take a fresh quote rather than executing a stale plan/);
      return true;
    },
  );

  // One millisecond past the deadline is already too late.
  assert.throws(() => assertExecutable(plan, plan.expiresAt + 1), RouteError);
});

// ---------------------------------------------------------------------------
// hashPolicy
// ---------------------------------------------------------------------------

test("hashPolicy changes when any execution limit changes", () => {
  const base = hashPolicy(DEFAULT_POLICY);
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.equal(hashPolicy({ ...DEFAULT_POLICY }), base);

  const changes: Partial<Policy>[] = [
    { maxImpactBps: 30 },
    { maxSlippageBps: 20 },
    { minDepthNotionalUsd: 25_000 },
    { depthWindowBps: 25 },
    { snapshotMaxAgeMs: 2_000 },
    { venueAllowlist: ["BINANCE_SPOT"] },
    { maxQuoteDisagreementBps: 10 },
    { maxOrderNotionalUsd: 10_000 },
  ];

  for (const change of changes) {
    const field = Object.keys(change)[0];
    assert.notEqual(hashPolicy({ ...DEFAULT_POLICY, ...change }), base, `${field} should change the hash`);
  }
});

test("hashPolicy tells an unset limit apart from a set one", () => {
  const base = hashPolicy(DEFAULT_POLICY);
  const { maxImpactBps, ...withoutImpactCap } = DEFAULT_POLICY;

  assert.notEqual(hashPolicy(withoutImpactCap), base);
  assert.equal(maxImpactBps, 25);
});

test("hashPolicy ignores limits that cannot change a route", () => {
  // The hash covers what the router reads. Rate limits and loss limits belong
  // to the risk engine, and folding them in would invalidate a fingerprint for
  // a change that could not have altered the decision.
  const base = hashPolicy(DEFAULT_POLICY);

  assert.equal(hashPolicy({ ...DEFAULT_POLICY, maxOrdersPerHour: 1 }), base);
  assert.equal(hashPolicy({ ...DEFAULT_POLICY, dailyLossLimitPct: 0.5 }), base);
  assert.equal(hashPolicy({ ...DEFAULT_POLICY, mode: "live" }), base);
});

// ---------------------------------------------------------------------------
// measuredImpactBps
// ---------------------------------------------------------------------------

test("measuredImpactBps measures from the touch, not from mid", () => {
  const snapshot = makeSnapshot();

  // An order that fits on the touch moves the book none.
  assert.equal(measuredImpactBps(snapshot, "BUY", LEVEL_QTY), 0);

  // 12 BNB averages 752.0175, which is 0.75 cents past the 752.01 touch.
  closeTo(measuredImpactBps(snapshot, "BUY", 12), ((752.0175 - BEST_ASK) / MID) * 10_000, 1e-9);

  // Which is the same figure the cost model charges as book impact.
  const fromCost = costBinanceTaker({ snapshot, side: "BUY", baseQty: 12 }).components.find(
    (c) => c.name === "book impact",
  );
  closeTo(measuredImpactBps(snapshot, "BUY", 12), fromCost!.bps, 1e-9);
});

test("measuredImpactBps is infinite for a size the book cannot fill", () => {
  assert.equal(measuredImpactBps(makeSnapshot(), "BUY", 100), Infinity);
  assert.equal(
    measuredImpactBps({ ...makeSnapshot(), book: { bids: [], asks: [], lastUpdateId: 1 } }, "BUY", 1),
    Infinity,
  );
});
