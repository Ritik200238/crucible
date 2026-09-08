import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ALL_RULES,
  allowedMarkets,
  confirmAboveNotional,
  cooldownAfterLoss,
  dailyLossLimit,
  inWindow,
  maxDailyNotional,
  maxImpact,
  maxLeverage,
  maxOrderNotional,
  maxOrdersPerHour,
  maxPositionConcentration,
  maxSlippage,
  minDepthNotional,
  noTradeWindows,
  orderNotionalUsd,
  quoteDisagreement,
  reducesRisk,
  restingNotionalUsd,
  snapshotMaxAge,
  symbolPermitted,
  venueAllowlist,
} from "../src/risk/rules.ts";
import {
  activeRules,
  assertSupportedQuote,
  evaluate,
  InvalidOrderError,
  reduceVerdict,
  validateOrder,
} from "../src/risk/engine.ts";
import type {
  EvaluationContext,
  OnchainQuote,
  Policy,
  ProposedOrder,
  RuleResult,
  Snapshot,
  Verdict,
  WalletQuote,
} from "../src/types.ts";

const NOW = new Date("2026-09-08T12:00:00.000Z");
const MID = 600;

const noRules: Policy = { version: 1, mode: "dry-run" };
const policy = (over: Partial<Policy>): Policy => ({ ...noRules, ...over });

function ctx(p: Policy, over: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    policy: p,
    account: {
      equityUsd: 100_000,
      positions: [],
      realisedPnlTodayUsd: 0,
      source: "simulated",
    },
    state: {
      day: "2026-09-08",
      notionalTodayUsd: 0,
      ordersToday: 0,
      recentOrderTimes: [],
      lastLossAt: null,
      realisedPnlTodayUsd: 0,
    },
    markPrice: MID,
    now: NOW,
    ...over,
  };
}

const buy = (over: Partial<ProposedOrder> = {}): ProposedOrder => ({
  symbol: "BNBUSDT",
  side: "BUY",
  type: "MARKET",
  market: "SPOT",
  quoteOrderQty: 1_000,
  ...over,
});

const limitAt = (price: number, over: Partial<ProposedOrder> = {}): ProposedOrder =>
  buy({ type: "LIMIT", price, quantity: 2, quoteOrderQty: undefined, ...over });

/**
 * A two-sided book around a mid of 600. Ten bps out is 600.60 on the ask and
 * 599.40 on the bid, so the third level of each side sits outside that window
 * and the depth rule must not count it.
 */
function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    symbol: "BNBUSDT",
    takenAt: NOW.getTime(),
    mid: MID,
    bestBid: 599.9,
    bestAsk: 600.1,
    spreadBps: 3.33,
    book: {
      bids: [
        { price: 599.9, qty: 100 },
        { price: 599.5, qty: 50 },
        { price: 599.0, qty: 400 },
      ],
      asks: [
        { price: 600.1, qty: 10 },
        { price: 600.5, qty: 5 },
        { price: 601.0, qty: 400 },
      ],
      lastUpdateId: 42,
    },
    filters: {
      symbol: "BNBUSDT",
      baseAsset: "BNB",
      quoteAsset: "USDT",
      baseAssetPrecision: 8,
      quoteAssetPrecision: 8,
      stepSize: 0.001,
      minQty: 0.001,
      maxQty: 9_000,
      tickSize: 0.01,
      minNotional: 5,
    },
    commission: { maker: 0.001, taker: 0.001, source: "vip0-default" },
    flow: { hitsBidPerSec: 1.4, liftsAskPerSec: 1.6, windowSec: 60 },
    onchain: null,
    hash: "0".repeat(64),
    ...over,
  };
}

function onchainQuote(walletQuote: WalletQuote | null, poolPrice = MID): OnchainQuote {
  const tier = {
    feeTier: 500,
    amountOut: 6_000 / poolPrice,
    price: poolPrice,
    gasEstimate: 180_000,
  };
  return {
    chainId: 56,
    tokenIn: "USDT",
    tokenOut: "BNB",
    amountIn: 6_000,
    tiers: [tier],
    best: tier,
    gasPriceWei: 1_000_000_000,
    gasCostUsd: 0.12,
    referencePrice: poolPrice,
    walletQuote,
  };
}

// ---------------------------------------------------------------------------
// Execution rules
// ---------------------------------------------------------------------------

describe("maxImpact", () => {
  const p = policy({ maxImpactBps: 25 });

  test("allows a walk inside the cap", () => {
    const r = maxImpact.evaluate(buy(), ctx(p, { impactBps: 12 }));
    assert.equal(r?.verdict, "ALLOW");
    assert.match(r!.message, /12\.0 bps/);
  });

  test("blocks a walk over the cap and names both numbers", () => {
    const r = maxImpact.evaluate(buy(), ctx(p, { impactBps: 47.2 }));
    assert.equal(r?.verdict, "BLOCK");
    assert.match(r!.message, /47\.2 bps/);
    assert.match(r!.message, /25\.0 bps/);
  });

  test("is inert when unconfigured", () => {
    assert.equal(maxImpact.evaluate(buy(), ctx(noRules, { impactBps: 900 })), null);
  });

  test("is inert when the context carries no impact figure", () => {
    assert.equal(maxImpact.evaluate(buy(), ctx(p)), null);
  });

  test("a risk-reducing order escapes the cap", () => {
    const r = maxImpact.evaluate(buy({ side: "SELL" }), ctx(p, { impactBps: 400 }));
    assert.equal(r?.verdict, "ALLOW", "you must always be able to get out");
    assert.match(r!.message, /Skipped/);
  });

  test("a reduceOnly futures order escapes the cap too", () => {
    const o = buy({ market: "USDM_FUTURES", reduceOnly: true });
    assert.equal(maxImpact.evaluate(o, ctx(p, { impactBps: 400 }))?.verdict, "ALLOW");
  });
});

describe("maxSlippage", () => {
  const p = policy({ maxSlippageBps: 25 });

  test("allows a limit price inside the cap", () => {
    // 600.60 against a 600 mid is 10 bps.
    const r = maxSlippage.evaluate(limitAt(600.6), ctx(p, { snapshot: snapshot() }));
    assert.equal(r?.verdict, "ALLOW");
  });

  test("blocks a limit price that has drifted past the cap", () => {
    // 603 against a 600 mid is 50 bps.
    const r = maxSlippage.evaluate(limitAt(603), ctx(p, { snapshot: snapshot() }));
    assert.equal(r?.verdict, "BLOCK");
    assert.match(r!.message, /50\.0 bps/);
    assert.equal(Math.round(r!.detail!.driftBps as number), 50);
  });

  test("measures drift below the mid as well as above", () => {
    const r = maxSlippage.evaluate(limitAt(597), ctx(p, { snapshot: snapshot() }));
    assert.equal(r?.verdict, "BLOCK");
  });

  test("is inert when unconfigured", () => {
    assert.equal(maxSlippage.evaluate(limitAt(700), ctx(noRules, { snapshot: snapshot() })), null);
  });

  test("is inert without a snapshot", () => {
    assert.equal(maxSlippage.evaluate(limitAt(700), ctx(p)), null);
  });

  test("is inert for an order that carries no price", () => {
    assert.equal(maxSlippage.evaluate(buy(), ctx(p, { snapshot: snapshot() })), null);
  });

  test("refuses to guess when the snapshot has no usable mid", () => {
    const r = maxSlippage.evaluate(limitAt(600), ctx(p, { snapshot: snapshot({ mid: 0 }) }));
    assert.equal(r?.verdict, "BLOCK");
  });
});

describe("restingNotionalUsd", () => {
  const book = snapshot().book;

  test("counts only the ask levels inside the window for a buy", () => {
    // 600.10 x 10 + 600.50 x 5 = 9,003.50. The 601.00 level is outside 10 bps.
    const total = restingNotionalUsd(book, "BUY", MID, 10);
    assert.ok(Math.abs(total - 9_003.5) < 1e-6, `got ${total}`);
  });

  test("counts only the bid levels inside the window for a sell", () => {
    // 599.90 x 100 + 599.50 x 50 = 89,965. The 599.00 level is outside 10 bps.
    const total = restingNotionalUsd(book, "SELL", MID, 10);
    assert.ok(Math.abs(total - 89_965) < 1e-6, `got ${total}`);
  });

  test("a wider window reaches the level beyond the touch", () => {
    const total = restingNotionalUsd(book, "BUY", MID, 50);
    assert.ok(total > 200_000, `got ${total}`);
  });
});

describe("minDepthNotional", () => {
  const p = policy({ minDepthNotionalUsd: 20_000, depthWindowBps: 10 });

  test("blocks a buy when the ask side is too thin", () => {
    const r = minDepthNotional.evaluate(buy(), ctx(p, { snapshot: snapshot() }));
    assert.equal(r?.verdict, "BLOCK");
    assert.equal(r!.detail!.side, "ask");
  });

  test("allows the same book for a sell, where the bid side is deep", () => {
    const r = minDepthNotional.evaluate(buy({ side: "SELL" }), ctx(p, { snapshot: snapshot() }));
    assert.equal(r?.verdict, "ALLOW");
    assert.equal(r!.detail!.side, "bid");
  });

  test("allows a buy once the floor is below the resting size", () => {
    const thin = policy({ minDepthNotionalUsd: 5_000, depthWindowBps: 10 });
    const r = minDepthNotional.evaluate(buy(), ctx(thin, { snapshot: snapshot() }));
    assert.equal(r?.verdict, "ALLOW");
  });

  test("is inert when unconfigured", () => {
    assert.equal(minDepthNotional.evaluate(buy(), ctx(noRules, { snapshot: snapshot() })), null);
  });

  test("is inert when a floor is set without a window to measure it in", () => {
    const halfSet = policy({ minDepthNotionalUsd: 20_000 });
    assert.equal(minDepthNotional.isConfigured(halfSet), false);
    assert.equal(minDepthNotional.evaluate(buy(), ctx(halfSet, { snapshot: snapshot() })), null);
  });

  test("is inert without a snapshot", () => {
    assert.equal(minDepthNotional.evaluate(buy(), ctx(p)), null);
  });
});

describe("snapshotMaxAge", () => {
  const p = policy({ snapshotMaxAgeMs: 2_000 });

  test("allows a fresh snapshot", () => {
    const fresh = snapshot({ takenAt: NOW.getTime() - 500 });
    const r = snapshotMaxAge.evaluate(buy(), ctx(p, { snapshot: fresh }));
    assert.equal(r?.verdict, "ALLOW");
    assert.equal(r!.detail!.ageMs, 500);
  });

  test("blocks a stale snapshot", () => {
    const stale = snapshot({ takenAt: NOW.getTime() - 9_000 });
    const r = snapshotMaxAge.evaluate(buy(), ctx(p, { snapshot: stale }));
    assert.equal(r?.verdict, "BLOCK");
    assert.match(r!.message, /9,000 ms/);
    assert.match(r!.message, /2,000 ms/);
  });

  test("allows a snapshot exactly at the limit", () => {
    const edge = snapshot({ takenAt: NOW.getTime() - 2_000 });
    assert.equal(snapshotMaxAge.evaluate(buy(), ctx(p, { snapshot: edge }))?.verdict, "ALLOW");
  });

  test("is inert when unconfigured", () => {
    const stale = snapshot({ takenAt: NOW.getTime() - 600_000 });
    assert.equal(snapshotMaxAge.evaluate(buy(), ctx(noRules, { snapshot: stale })), null);
  });

  test("is inert without a snapshot", () => {
    assert.equal(snapshotMaxAge.evaluate(buy(), ctx(p)), null);
  });
});

describe("venueAllowlist", () => {
  const p = policy({ venueAllowlist: ["BINANCE_SPOT"] });

  test("allows a venue on the list", () => {
    const r = venueAllowlist.evaluate(buy({ venue: "BINANCE_SPOT" }), ctx(p));
    assert.equal(r?.verdict, "ALLOW");
  });

  test("blocks a venue off the list", () => {
    const r = venueAllowlist.evaluate(buy({ venue: "ONCHAIN" }), ctx(p));
    assert.equal(r?.verdict, "BLOCK");
    assert.match(r!.message, /ONCHAIN/);
    assert.match(r!.message, /BINANCE_SPOT/);
  });

  test("is inert when unconfigured", () => {
    assert.equal(venueAllowlist.evaluate(buy({ venue: "ONCHAIN" }), ctx(noRules)), null);
  });

  test("is inert before a route has been chosen", () => {
    assert.equal(venueAllowlist.evaluate(buy(), ctx(p)), null);
  });
});

describe("quoteDisagreement", () => {
  const p = policy({ maxQuoteDisagreementBps: 30 });
  // 6,000 USDT in for 10 BNB out is an effective 600 per BNB, the pool price.
  const agreeing: WalletQuote = {
    fromSymbol: "USDT",
    toSymbol: "BNB",
    amountIn: 6_000,
    amountOut: 10,
    slippage: 0.005,
  };

  test("allows two quotes that agree", () => {
    const s = snapshot({ onchain: onchainQuote(agreeing) });
    const r = quoteDisagreement.evaluate(buy(), ctx(p, { snapshot: s }));
    assert.equal(r?.verdict, "ALLOW");
  });

  test("blocks two quotes that do not", () => {
    // 6,000 for 9.9 BNB is 606.06 per BNB, about 100 bps off the pool's 600.
    const s = snapshot({ onchain: onchainQuote({ ...agreeing, amountOut: 9.9 }) });
    const r = quoteDisagreement.evaluate(buy(), ctx(p, { snapshot: s }));
    assert.equal(r?.verdict, "BLOCK");
    assert.ok((r!.detail!.gapBps as number) > 90);
    assert.match(r!.message, /30\.0 bps/);
  });

  test("reads the wallet ratio the other way up for a sell", () => {
    const selling: WalletQuote = {
      fromSymbol: "BNB",
      toSymbol: "USDT",
      amountIn: 10,
      amountOut: 6_000,
      slippage: 0.005,
    };
    const s = snapshot({ onchain: onchainQuote(selling) });
    const r = quoteDisagreement.evaluate(buy({ side: "SELL" }), ctx(p, { snapshot: s }));
    assert.equal(r?.verdict, "ALLOW", "10 BNB for 6,000 USDT is the same 600 price");
  });

  test("is inert when unconfigured", () => {
    const s = snapshot({ onchain: onchainQuote({ ...agreeing, amountOut: 5 }) });
    assert.equal(quoteDisagreement.evaluate(buy(), ctx(noRules, { snapshot: s })), null);
  });

  test("is inert when the wallet quote is missing", () => {
    const s = snapshot({ onchain: onchainQuote(null) });
    assert.equal(quoteDisagreement.evaluate(buy(), ctx(p, { snapshot: s })), null);
  });

  test("is inert when no pool tier answered", () => {
    const s = snapshot({ onchain: { ...onchainQuote(agreeing), best: null } });
    assert.equal(quoteDisagreement.evaluate(buy(), ctx(p, { snapshot: s })), null);
  });

  test("is inert when there is no on-chain side at all", () => {
    assert.equal(quoteDisagreement.evaluate(buy(), ctx(p, { snapshot: snapshot() })), null);
  });
});

// ---------------------------------------------------------------------------
// The rules that were already here
// ---------------------------------------------------------------------------

describe("orderNotionalUsd", () => {
  test("takes quoteOrderQty at face value", () => {
    assert.equal(orderNotionalUsd(buy({ quoteOrderQty: 250 }), MID), 250);
  });

  test("prices a LIMIT order at its own limit price, not the mark", () => {
    assert.equal(orderNotionalUsd(limitAt(700), MID), 1_400);
  });
});

describe("reducesRisk", () => {
  test("a spot sell reduces exposure", () => {
    assert.equal(reducesRisk(buy({ side: "SELL" })), true);
  });

  test("a reduceOnly futures order reduces exposure", () => {
    assert.equal(reducesRisk(buy({ market: "USDM_FUTURES", reduceOnly: true })), true);
  });

  test("a spot buy does not", () => {
    assert.equal(reducesRisk(buy()), false);
  });
});

describe("allowedMarkets", () => {
  const p = policy({ allowedMarkets: ["SPOT"] });

  test("allows a market on the list", () => {
    assert.equal(allowedMarkets.evaluate(buy(), ctx(p))?.verdict, "ALLOW");
  });

  test("blocks a market off the list", () => {
    const o = buy({ market: "USDM_FUTURES" });
    assert.equal(allowedMarkets.evaluate(o, ctx(p))?.verdict, "BLOCK");
  });
});

describe("symbolPermitted", () => {
  test("matches the allowlist regardless of case", () => {
    const p = policy({ symbolAllowlist: ["bnbusdt", "ethusdt"] });
    assert.equal(symbolPermitted.evaluate(buy(), ctx(p))?.verdict, "ALLOW");
  });

  test("blocks a symbol that is not on the allowlist", () => {
    const p = policy({ symbolAllowlist: ["ETHUSDT"] });
    assert.equal(symbolPermitted.evaluate(buy(), ctx(p))?.verdict, "BLOCK");
  });

  test("the denylist wins even when the allowlist would pass", () => {
    const p = policy({ symbolAllowlist: ["BNBUSDT"], symbolDenylist: ["bnbusdt"] });
    assert.equal(symbolPermitted.evaluate(buy(), ctx(p))?.verdict, "BLOCK");
  });
});

describe("maxOrderNotional", () => {
  const p = policy({ maxOrderNotionalUsd: 1_000 });

  test("allows an order at the cap", () => {
    assert.equal(maxOrderNotional.evaluate(buy(), ctx(p))?.verdict, "ALLOW");
  });

  test("blocks a cent over the cap", () => {
    const r = maxOrderNotional.evaluate(buy({ quoteOrderQty: 1_000.01 }), ctx(p));
    assert.equal(r?.verdict, "BLOCK");
  });
});

describe("maxPositionConcentration", () => {
  const p = policy({ maxPositionPctOfEquity: 25 });
  const holding = (notionalUsd: number, symbol = "BNBUSDT") =>
    ctx(p, {
      account: {
        equityUsd: 100_000,
        positions: [{ symbol, notionalUsd }],
        realisedPnlTodayUsd: 0,
        source: "simulated",
      },
    });

  test("counts exposure already held toward the cap", () => {
    // 20,000 held + 10,000 new = 30% of a 100,000 account, over the 25% cap.
    const r = maxPositionConcentration.evaluate(buy({ quoteOrderQty: 10_000 }), holding(20_000));
    assert.equal(r?.verdict, "BLOCK");
    assert.equal(r!.detail!.existingUsd, 20_000);
  });

  test("ignores exposure held in a different symbol", () => {
    const r = maxPositionConcentration.evaluate(
      buy({ quoteOrderQty: 10_000 }),
      holding(90_000, "ETHUSDT"),
    );
    assert.equal(r?.verdict, "ALLOW");
  });

  test("never blocks an order that reduces exposure", () => {
    const r = maxPositionConcentration.evaluate(
      buy({ side: "SELL", quoteOrderQty: 10_000 }),
      holding(90_000),
    );
    assert.equal(r?.verdict, "ALLOW");
    assert.match(r!.message, /reduces exposure/);
  });
});

describe("maxLeverage", () => {
  const p = policy({ maxLeverage: 5 });

  test("blocks above the cap", () => {
    const o = buy({ market: "USDM_FUTURES", leverage: 20 });
    assert.equal(maxLeverage.evaluate(o, ctx(p))?.verdict, "BLOCK");
  });

  test("does not apply when the order names no leverage", () => {
    assert.equal(maxLeverage.evaluate(buy(), ctx(p)), null);
  });
});

describe("dailyLossLimit", () => {
  const p = policy({ dailyLossLimitPct: 5 });
  const downBy = (usd: number) =>
    ctx(p, {
      state: {
        day: "2026-09-08",
        notionalTodayUsd: 0,
        ordersToday: 0,
        recentOrderTimes: [],
        lastLossAt: null,
        realisedPnlTodayUsd: -usd,
      },
    });

  test("blocks new risk once the limit is reached", () => {
    assert.equal(dailyLossLimit.evaluate(buy(), downBy(5_000))?.verdict, "BLOCK");
  });

  test("still lets you close after the halt", () => {
    const r = dailyLossLimit.evaluate(buy({ side: "SELL" }), downBy(20_000));
    assert.equal(r?.verdict, "ALLOW", "you must always be able to get out");
  });

  test("allows new risk while inside the limit", () => {
    assert.equal(dailyLossLimit.evaluate(buy(), downBy(1_000))?.verdict, "ALLOW");
  });
});

describe("maxDailyNotional", () => {
  const p = policy({ maxDailyNotionalUsd: 50_000 });
  const used = (notionalTodayUsd: number) =>
    ctx(p, {
      state: {
        day: "2026-09-08",
        notionalTodayUsd,
        ordersToday: 4,
        recentOrderTimes: [],
        lastLossAt: null,
        realisedPnlTodayUsd: 0,
      },
    });

  test("counts today's volume toward the cap", () => {
    const r = maxDailyNotional.evaluate(buy({ quoteOrderQty: 10_000 }), used(45_000));
    assert.equal(r?.verdict, "BLOCK");
  });

  test("allows an order that still fits", () => {
    const r = maxDailyNotional.evaluate(buy({ quoteOrderQty: 4_000 }), used(45_000));
    assert.equal(r?.verdict, "ALLOW");
  });
});

describe("cooldownAfterLoss", () => {
  const p = policy({ cooldownAfterLossMinutes: 30 });
  const lostAt = (minutesAgo: number) =>
    ctx(p, {
      state: {
        day: "2026-09-08",
        notionalTodayUsd: 0,
        ordersToday: 1,
        recentOrderTimes: [],
        lastLossAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
        realisedPnlTodayUsd: -400,
      },
    });

  test("blocks a new entry inside the cooldown", () => {
    assert.equal(cooldownAfterLoss.evaluate(buy(), lostAt(10))?.verdict, "BLOCK");
  });

  test("lets a closing order through inside the cooldown", () => {
    const r = cooldownAfterLoss.evaluate(buy({ side: "SELL" }), lostAt(10));
    assert.equal(r?.verdict, "ALLOW");
  });

  test("clears once the cooldown has run", () => {
    assert.equal(cooldownAfterLoss.evaluate(buy(), lostAt(31))?.verdict, "ALLOW");
  });
});

describe("maxOrdersPerHour", () => {
  const p = policy({ maxOrdersPerHour: 3 });
  const sentAt = (...minutesAgo: number[]) =>
    ctx(p, {
      state: {
        day: "2026-09-08",
        notionalTodayUsd: 0,
        ordersToday: minutesAgo.length,
        recentOrderTimes: minutesAgo.map((m) =>
          new Date(NOW.getTime() - m * 60_000).toISOString(),
        ),
        lastLossAt: null,
        realisedPnlTodayUsd: 0,
      },
    });

  test("blocks once the hour is full", () => {
    assert.equal(maxOrdersPerHour.evaluate(buy(), sentAt(5, 20, 50))?.verdict, "BLOCK");
  });

  test("ignores orders that have aged out of the window", () => {
    const r = maxOrdersPerHour.evaluate(buy(), sentAt(5, 70, 200));
    assert.equal(r?.verdict, "ALLOW");
    assert.equal(r!.detail!.inWindow, 1);
  });
});

describe("noTradeWindows", () => {
  const p = policy({ noTradeWindowsUtc: [{ start: "23:30", end: "00:30", label: "rollover" }] });

  test("a window crossing midnight still catches the hours after it", () => {
    const at = new Date("2026-09-09T00:15:00.000Z");
    assert.equal(noTradeWindows.evaluate(buy(), ctx(p, { now: at }))?.verdict, "BLOCK");
  });

  test("outside the window nothing is blocked", () => {
    assert.equal(noTradeWindows.evaluate(buy(), ctx(p))?.verdict, "ALLOW");
  });

  test("inWindow handles both sides of midnight", () => {
    const w = { start: "23:30", end: "00:30" };
    assert.equal(inWindow(new Date("2026-09-08T23:45:00.000Z"), w), true);
    assert.equal(inWindow(new Date("2026-09-08T22:00:00.000Z"), w), false);
  });
});

describe("confirmAboveNotional", () => {
  const p = policy({ confirmAboveNotionalUsd: 5_000 });

  test("escalates an order at the threshold instead of refusing it", () => {
    const r = confirmAboveNotional.evaluate(buy({ quoteOrderQty: 5_000 }), ctx(p));
    assert.equal(r?.verdict, "CONFIRM");
  });

  test("passes an order below it", () => {
    assert.equal(confirmAboveNotional.evaluate(buy(), ctx(p))?.verdict, "ALLOW");
  });
});

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

describe("reduceVerdict", () => {
  const result = (rule: string, verdict: Verdict): RuleResult => ({
    rule,
    verdict,
    message: "",
  });

  test("one BLOCK outranks any number of passes", () => {
    const r = reduceVerdict([
      result("a", "ALLOW"),
      result("b", "ALLOW"),
      result("c", "BLOCK"),
      result("d", "ALLOW"),
      result("e", "CONFIRM"),
    ]);
    assert.equal(r.verdict, "BLOCK");
    assert.deepEqual(r.blockedBy, ["c"]);
    assert.deepEqual(r.confirmRequiredBy, ["e"]);
  });

  test("CONFIRM outranks ALLOW", () => {
    const r = reduceVerdict([result("a", "ALLOW"), result("b", "CONFIRM")]);
    assert.equal(r.verdict, "CONFIRM");
    assert.deepEqual(r.confirmRequiredBy, ["b"]);
  });

  test("no results at all is an ALLOW", () => {
    const r = reduceVerdict([]);
    assert.equal(r.verdict, "ALLOW");
    assert.deepEqual(r.blockedBy, []);
  });
});

describe("validateOrder", () => {
  test("refuses a pair that is not quoted in a USD-pegged asset", () => {
    assert.throws(() => validateOrder(buy({ symbol: "BNBBTC" })), InvalidOrderError);
    assert.throws(() => assertSupportedQuote("ETHBTC"), InvalidOrderError);
  });

  test("refuses an order that names both sizes", () => {
    assert.throws(() => validateOrder(buy({ quantity: 1 })), InvalidOrderError);
  });

  test("refuses an order that names neither", () => {
    assert.throws(() => validateOrder(buy({ quoteOrderQty: undefined })), InvalidOrderError);
  });

  test("refuses leverage on a spot order", () => {
    assert.throws(() => validateOrder(buy({ leverage: 3 })), InvalidOrderError);
  });

  test("accepts a well-formed spot order", () => {
    assert.doesNotThrow(() => validateOrder(buy()));
  });
});

describe("evaluate", () => {
  const full = policy({
    maxOrderNotionalUsd: 10_000,
    maxImpactBps: 25,
    snapshotMaxAgeMs: 2_000,
    venueAllowlist: ["BINANCE_SPOT"],
  });

  test("an execution rule can block an order the size rules would pass", () => {
    const d = evaluate(
      buy({ venue: "BINANCE_SPOT" }),
      ctx(full, { impactBps: 60, snapshot: snapshot() }),
    );
    assert.equal(d.verdict, "BLOCK");
    assert.deepEqual(d.blockedBy, ["max_impact_bps"]);
    assert.equal(d.notionalUsd, 1_000);
  });

  test("every configured rule reports, and a clean order passes", () => {
    const d = evaluate(
      buy({ venue: "BINANCE_SPOT" }),
      ctx(full, { impactBps: 8, snapshot: snapshot({ takenAt: NOW.getTime() - 100 }) }),
    );
    assert.equal(d.verdict, "ALLOW");
    const reported = d.results.map((r) => r.rule);
    for (const name of ["max_order_notional", "max_impact_bps", "snapshot_max_age", "venue_allowlist"]) {
      assert.ok(reported.includes(name), `${name} did not report`);
    }
  });

  test("a stale snapshot blocks even when nothing else objects", () => {
    const d = evaluate(
      buy({ venue: "BINANCE_SPOT" }),
      ctx(full, { impactBps: 8, snapshot: snapshot({ takenAt: NOW.getTime() - 30_000 }) }),
    );
    assert.deepEqual(d.blockedBy, ["snapshot_max_age"]);
  });

  test("several rules can block at once and all of them are named", () => {
    const d = evaluate(
      buy({ venue: "ONCHAIN", quoteOrderQty: 50_000 }),
      ctx(full, { impactBps: 900, snapshot: snapshot({ takenAt: NOW.getTime() - 30_000 }) }),
    );
    assert.equal(d.verdict, "BLOCK");
    assert.deepEqual(d.blockedBy, [
      "max_order_notional",
      "max_impact_bps",
      "snapshot_max_age",
      "venue_allowlist",
    ]);
  });
});

describe("activeRules", () => {
  test("lists nothing when no rule is configured", () => {
    assert.deepEqual(activeRules(noRules), []);
  });

  test("lists the execution rules the operator switched on", () => {
    const p = policy({
      maxImpactBps: 25,
      maxSlippageBps: 20,
      minDepthNotionalUsd: 50_000,
      depthWindowBps: 10,
      snapshotMaxAgeMs: 2_000,
      venueAllowlist: ["BINANCE_SPOT", "ONCHAIN"],
      maxQuoteDisagreementBps: 30,
    });
    assert.deepEqual(
      activeRules(p).map((r) => r.name),
      [
        "max_impact_bps",
        "max_slippage_bps",
        "min_depth_notional",
        "snapshot_max_age",
        "venue_allowlist",
        "quote_disagreement",
      ],
    );
  });

  test("every rule states what it protects against", () => {
    for (const rule of ALL_RULES) {
      assert.ok(rule.purpose.length > 20, `${rule.name} has no usable purpose`);
    }
  });
});

describe("ALL_RULES", () => {
  test("runs in the documented order", () => {
    assert.deepEqual(
      ALL_RULES.map((r) => r.name),
      [
        "allowed_markets",
        "symbol_permitted",
        "max_leverage",
        "max_order_notional",
        "max_position_concentration",
        "daily_loss_limit",
        "max_daily_notional",
        "cooldown_after_loss",
        "max_orders_per_hour",
        "no_trade_window",
        "confirm_above_notional",
        "max_impact_bps",
        "max_slippage_bps",
        "min_depth_notional",
        "snapshot_max_age",
        "venue_allowlist",
        "quote_disagreement",
      ],
    );
  });

  test("no rule name is used twice", () => {
    const names = ALL_RULES.map((r) => r.name);
    assert.equal(new Set(names).size, names.length);
  });
});
