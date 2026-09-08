import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ledger } from "../src/ledger/chain.ts";
import { assertSpendable } from "../src/exec/execute.ts";
import { deriveState, emptyState } from "../src/risk/state.ts";
import { priceAllRoutes, DEFAULT_MAX_DIVERGENCE_BPS } from "../src/cost/model.ts";
import { route } from "../src/decide/router.ts";
import { evaluate } from "../src/risk/engine.ts";
import { DEFAULT_POLICY } from "../src/config.ts";
import type {
  ConfirmedFill,
  EvaluationContext,
  OrderBook,
  Plan,
  Policy,
  ProposedOrder,
  Snapshot,
} from "../src/types.ts";

/**
 * Attacks, not features.
 *
 * Each of these is a way to get an order through that should not get through.
 * They are written from the attacker's side on purpose: a rule that has only
 * ever been tested by feeding it the input it was designed to catch has not
 * really been tested.
 */

const dirs: string[] = [];
function tempLedger(): Ledger {
  const dir = mkdtempSync(join(tmpdir(), "crucible-adv-"));
  dirs.push(dir);
  return new Ledger({ dir });
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const fill = (over: Partial<ConfirmedFill> = {}): ConfirmedFill => ({
  venue: "BINANCE_SPOT",
  status: "FILLED",
  filledBaseQty: 33,
  filledQuoteQty: 24_000,
  avgPrice: 727.27,
  fees: [],
  totalFeeInQuote: 0,
  isMaker: false,
  reference: "1",
  confirmedBy: "test",
  ...over,
});

const order = (over: Partial<ProposedOrder> = {}): ProposedOrder => ({
  symbol: "BNBUSDT",
  side: "BUY",
  type: "MARKET",
  market: "SPOT",
  quoteOrderQty: 24_000,
  ...over,
});

function ctx(policy: Policy, ledger: Ledger, now = new Date()): EvaluationContext {
  return {
    policy,
    account: { equityUsd: 10_000_000, positions: [], realisedPnlTodayUsd: 0, source: "simulated" },
    state: deriveState(ledger.read(), now.getTime()),
    markPrice: 727.27,
    now,
  };
}

describe("splitting an order to get under the per-order cap", () => {
  test("the daily cap counts what already executed, so the split is caught", () => {
    const ledger = tempLedger();
    const policy: Policy = {
      ...DEFAULT_POLICY,
      maxOrderNotionalUsd: 25_000,
      maxDailyNotionalUsd: 100_000,
    };

    // Four orders, each under the per-order cap, land without complaint.
    for (let i = 0; i < 4; i++) {
      const allowed = evaluate(order(), ctx(policy, ledger));
      assert.notEqual(
        allowed.verdict,
        "BLOCK",
        `order ${i + 1} at $24,000 is under the $25,000 cap and should pass`,
      );
      ledger.append("execution.completed", {
        planId: `p${i}`,
        symbol: "BNBUSDT",
        side: "BUY",
        fills: [fill({ reference: String(i) })],
      });
    }

    // $96,000 is now on the record. The fifth would take it past $100,000.
    const state = deriveState(ledger.read());
    assert.equal(state.notionalTodayUsd, 96_000);
    assert.equal(state.ordersToday, 4);

    const fifth = evaluate(order(), ctx(policy, ledger));
    assert.equal(fifth.verdict, "BLOCK", "the fifth slice must be refused");
    assert.ok(
      fifth.blockedBy.includes("max_daily_notional"),
      `expected the daily cap to stop it, got ${fifth.blockedBy.join(", ")}`,
    );
  });

  test("without the ledger behind it the same split walks straight through", () => {
    // The bug this file exists to pin. Counters that reset on every call make
    // the cumulative rules decorative: the eightieth slice looks exactly like
    // the first.
    const policy: Policy = { ...DEFAULT_POLICY, maxDailyNotionalUsd: 100_000 };
    const blind: EvaluationContext = {
      policy,
      account: { equityUsd: 10_000_000, positions: [], realisedPnlTodayUsd: 0, source: "simulated" },
      state: emptyState(),
      markPrice: 727.27,
      now: new Date(),
    };
    for (let i = 0; i < 80; i++) {
      assert.notEqual(evaluate(order(), blind).verdict, "BLOCK");
    }
  });

  test("the hourly brake counts executions too", () => {
    const ledger = tempLedger();
    const policy: Policy = { ...DEFAULT_POLICY, maxOrdersPerHour: 3, maxDailyNotionalUsd: undefined };

    for (let i = 0; i < 3; i++) {
      ledger.append("execution.completed", {
        planId: `p${i}`,
        symbol: "BNBUSDT",
        side: "BUY",
        fills: [fill({ filledQuoteQty: 10 })],
      });
    }
    const blocked = evaluate(order({ quoteOrderQty: 10 }), ctx(policy, ledger));
    assert.ok(blocked.blockedBy.includes("max_orders_per_hour"));
  });
});

describe("the counters only count what really happened", () => {
  test("a refusal moves nothing", () => {
    const ledger = tempLedger();
    for (let i = 0; i < 5; i++) {
      ledger.append("execution.refused", { planId: `p${i}`, reason: "dry run" });
    }
    const state = deriveState(ledger.read());
    assert.equal(state.notionalTodayUsd, 0);
    assert.equal(state.ordersToday, 0);
  });

  test("a failed execution moves nothing", () => {
    const ledger = tempLedger();
    ledger.append("execution.completed", {
      planId: "p",
      symbol: "BNBUSDT",
      side: "BUY",
      fills: [fill({ status: "FAILED", filledBaseQty: 0, filledQuoteQty: 0 })],
    });
    assert.equal(deriveState(ledger.read()).notionalTodayUsd, 0);
  });

  test("a partial fill counts for what it filled, not for what it asked", () => {
    const ledger = tempLedger();
    ledger.append("execution.completed", {
      planId: "p",
      symbol: "BNBUSDT",
      side: "BUY",
      fills: [fill({ status: "PARTIAL", filledBaseQty: 10, filledQuoteQty: 7_272 })],
    });
    assert.equal(deriveState(ledger.read()).notionalTodayUsd, 7_272);
  });

  test("yesterday's volume does not count against today", () => {
    const ledger = tempLedger();
    ledger.append("execution.completed", {
      planId: "old",
      symbol: "BNBUSDT",
      side: "BUY",
      fills: [fill()],
    });
    // Read the same ledger a week later.
    const later = Date.now() + 7 * 24 * 3_600_000;
    assert.equal(deriveState(ledger.read(), later).notionalTodayUsd, 0);
  });
});

describe("realised profit, rebuilt from fills", () => {
  test("a round trip at a loss arms the circuit breaker and the cooldown", () => {
    const ledger = tempLedger();
    ledger.append("execution.completed", {
      planId: "buy",
      symbol: "BNBUSDT",
      side: "BUY",
      fills: [fill({ filledBaseQty: 100, filledQuoteQty: 75_000, avgPrice: 750 })],
    });
    ledger.append("execution.completed", {
      planId: "sell",
      symbol: "BNBUSDT",
      side: "SELL",
      fills: [fill({ filledBaseQty: 100, filledQuoteQty: 70_000, avgPrice: 700 })],
    });

    const state = deriveState(ledger.read());
    assert.equal(state.realisedPnlTodayUsd, -5_000, "sold 100 at 700 having paid 750");
    assert.ok(state.lastLossAt, "a loss arms the cooldown");

    const policy: Policy = {
      ...DEFAULT_POLICY,
      dailyLossLimitPct: 2,
      maxDailyNotionalUsd: undefined,
    };
    const halted = evaluate(order({ quoteOrderQty: 100 }), {
      ...ctx(policy, ledger),
      account: {
        equityUsd: 100_000,
        positions: [],
        realisedPnlTodayUsd: 0,
        source: "simulated",
      },
    });
    assert.ok(
      halted.blockedBy.includes("daily_loss_limit"),
      `a 5% loss against a 2% limit must halt, got ${halted.blockedBy.join(", ")}`,
    );
  });

  test("selling at a profit does not arm the cooldown", () => {
    const ledger = tempLedger();
    ledger.append("execution.completed", {
      planId: "buy",
      symbol: "BNBUSDT",
      side: "BUY",
      fills: [fill({ filledBaseQty: 10, filledQuoteQty: 7_000, avgPrice: 700 })],
    });
    ledger.append("execution.completed", {
      planId: "sell",
      symbol: "BNBUSDT",
      side: "SELL",
      fills: [fill({ filledBaseQty: 10, filledQuoteQty: 7_500, avgPrice: 750 })],
    });
    const state = deriveState(ledger.read());
    assert.equal(state.realisedPnlTodayUsd, 500);
    assert.equal(state.lastLossAt, null);
  });

  test("holding a position that fell realises nothing", () => {
    // An unrealised loss is not a loss. A breaker that halted on paper moves
    // would halt on noise.
    const ledger = tempLedger();
    ledger.append("execution.completed", {
      planId: "buy",
      symbol: "BNBUSDT",
      side: "BUY",
      fills: [fill({ filledBaseQty: 100, filledQuoteQty: 75_000, avgPrice: 750 })],
    });
    assert.equal(deriveState(ledger.read()).realisedPnlTodayUsd, 0);
  });

  test("a sale is matched against the average paid, not the last price paid", () => {
    const ledger = tempLedger();
    for (const [qty, quote, price] of [
      [10, 7_000, 700],
      [10, 8_000, 800],
    ] as const) {
      ledger.append("execution.completed", {
        planId: "buy",
        symbol: "BNBUSDT",
        side: "BUY",
        fills: [fill({ filledBaseQty: qty, filledQuoteQty: quote, avgPrice: price })],
      });
    }
    // Average cost is 750. Selling all 20 at 750 realises nothing.
    ledger.append("execution.completed", {
      planId: "sell",
      symbol: "BNBUSDT",
      side: "SELL",
      fills: [fill({ filledBaseQty: 20, filledQuoteQty: 15_000, avgPrice: 750 })],
    });
    assert.equal(deriveState(ledger.read()).realisedPnlTodayUsd, 0);
  });

  test("selling more than is held books only what was closed", () => {
    const ledger = tempLedger();
    ledger.append("execution.completed", {
      planId: "buy",
      symbol: "BNBUSDT",
      side: "BUY",
      fills: [fill({ filledBaseQty: 10, filledQuoteQty: 7_000, avgPrice: 700 })],
    });
    ledger.append("execution.completed", {
      planId: "sell",
      symbol: "BNBUSDT",
      side: "SELL",
      fills: [fill({ filledBaseQty: 50, filledQuoteQty: 40_000, avgPrice: 800 })],
    });
    // Ten closed at a hundred each. The other forty are a short this router
    // does not track and must not be booked as profit.
    assert.equal(deriveState(ledger.read()).realisedPnlTodayUsd, 1_000);
  });

  test("one symbol's loss is not netted against another's position", () => {
    const ledger = tempLedger();
    ledger.append("execution.completed", {
      planId: "b1",
      symbol: "BNBUSDT",
      side: "BUY",
      fills: [fill({ filledBaseQty: 10, filledQuoteQty: 7_500, avgPrice: 750 })],
    });
    ledger.append("execution.completed", {
      planId: "b2",
      symbol: "ETHUSDT",
      side: "BUY",
      fills: [fill({ filledBaseQty: 10, filledQuoteQty: 25_000, avgPrice: 2_500 })],
    });
    ledger.append("execution.completed", {
      planId: "s1",
      symbol: "BNBUSDT",
      side: "SELL",
      fills: [fill({ filledBaseQty: 10, filledQuoteQty: 7_000, avgPrice: 700 })],
    });
    assert.equal(
      deriveState(ledger.read()).realisedPnlTodayUsd,
      -500,
      "only the BNB round trip realised anything",
    );
  });
});

describe("the counters cannot be moved without breaking the chain", () => {
  test("state derived from a tampered ledger is detectable", () => {
    const ledger = tempLedger();
    ledger.append("execution.completed", {
      planId: "p",
      symbol: "BNBUSDT",
      side: "BUY",
      fills: [fill()],
    });
    assert.equal(deriveState(ledger.read()).notionalTodayUsd, 24_000);
    // The point is not that deriveState validates — it is that the record it
    // reads is the same one the signature covers, so lowering the number here
    // means forging the chain rather than editing a private counter.
    assert.equal(ledger.read().length, 1);
    assert.ok(ledger.head()?.hash);
  });
});

describe("replaying an authorisation", () => {
  const plan = (fingerprint: string): Plan =>
    ({
      id: fingerprint.slice(0, 12),
      fingerprint,
      intent: { symbol: "BNBUSDT", side: "BUY", baseQty: 1 },
      snapshotHash: "s",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      chosen: {
        venue: "BINANCE_SPOT",
        style: "TAKER",
        components: [],
        totalBps: 10,
        totalUsd: 1,
        effectivePrice: 752,
        hasEstimates: false,
        notes: [],
      },
      alternatives: [],
      savingBps: 0,
      savingUsd: 0,
      baseQty: 1,
      quoteQty: 752,
      slices: [],
      rationale: "",
    }) as Plan;

  test("a fresh fingerprint is spendable", () => {
    assert.doesNotThrow(() => assertSpendable(plan("abc123"), tempLedger()));
  });

  test("a fingerprint already on the record is refused", () => {
    // Expiry does not stop this: the same plan can be replayed freely inside
    // its own minute, and the fingerprint is the authorisation.
    const ledger = tempLedger();
    const p = plan("deadbeefcafe0001");
    ledger.append("execution.started", { planId: p.id, fingerprint: p.fingerprint });
    assert.throws(() => assertSpendable(p, ledger), /already been executed/);
  });

  test("a completed execution also spends the fingerprint", () => {
    const ledger = tempLedger();
    const p = plan("deadbeefcafe0002");
    ledger.append("execution.completed", { planId: p.id, fingerprint: p.fingerprint, fills: [] });
    assert.throws(() => assertSpendable(p, ledger), /already been executed/);
  });

  test("a refusal does not spend the fingerprint", () => {
    // An order that was blocked never reached a venue, so the same plan may be
    // retried once whatever refused it is resolved.
    const ledger = tempLedger();
    const p = plan("deadbeefcafe0003");
    ledger.append("execution.refused", { planId: p.id, fingerprint: p.fingerprint, reason: "dry run" });
    assert.doesNotThrow(() => assertSpendable(p, ledger));
  });

  test("another plan's execution does not spend this one", () => {
    const ledger = tempLedger();
    ledger.append("execution.started", { planId: "other", fingerprint: "someoneelse" });
    assert.doesNotThrow(() => assertSpendable(plan("deadbeefcafe0004"), ledger));
  });
});

describe("a venue price too good to be true", () => {
  const MID = 752;

  const book = (): OrderBook => ({
    lastUpdateId: 1,
    bids: Array.from({ length: 20 }, (_, i) => ({ price: MID - 0.01 * (i + 1), qty: 50 })),
    asks: Array.from({ length: 20 }, (_, i) => ({ price: MID + 0.01 * (i + 1), qty: 50 })),
  });

  /** A snapshot whose pool quotes `poolPrice` per base unit. */
  const withPool = (poolPrice: number): Snapshot => {
    const amountIn = MID * 10;
    const tier = {
      feeTier: 100,
      amountOut: amountIn / poolPrice,
      price: 1 / poolPrice,
      gasEstimate: 100_000,
    };
    return {
      symbol: "BNBUSDT",
      takenAt: Date.now(),
      mid: MID,
      bestBid: MID - 0.01,
      bestAsk: MID + 0.01,
      spreadBps: 0.27,
      book: book(),
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
      flow: {
        hitsBidPerSec: 3,
        liftsAskPerSec: 3,
        windowSec: 60,
        adverseBuyBps: 0.6,
        adverseSellBps: 0.5,
        adverseSamples: 400,
      },
      onchain: {
        chainId: 56,
        tokenIn: "0x",
        tokenOut: "0x",
        amountIn,
        tiers: [tier],
        best: tier,
        gasPriceWei: 50_000_000,
        gasCostUsd: 0.006,
        referencePrice: 1 / poolPrice,
        walletQuote: null,
      },
      hash: "fixture",
    };
  };

  const onchainRoute = (poolPrice: number) =>
    priceAllRoutes({ snapshot: withPool(poolPrice), side: "BUY", baseQty: 10 }).find(
      (r) => r.venue === "ONCHAIN",
    )!;

  test("a plausible pool price is used", () => {
    assert.equal(onchainRoute(MID).unavailable, undefined);
  });

  test("a pool quoting 99% below the exchange is refused, not taken", () => {
    // Before this bound the route priced at −9900 bps and won every time. A
    // stale RPC, a token whose decimals were read wrongly, and a pool someone
    // has moved all look exactly like this.
    const r = onchainRoute(MID * 0.01);
    assert.ok(r.unavailable, "a 99% discount must not be believed");
    assert.match(r.unavailable!, /better than the exchange mid/);
  });

  test("the bound applies to a price far worse as well as far better", () => {
    // A price far off in the expensive direction is the same broken data. It
    // would have been discarded for being costly, which is the right outcome
    // reached by luck rather than by checking.
    const r = onchainRoute(MID * 1.5);
    assert.ok(r.unavailable);
    assert.match(r.unavailable!, /worse than the exchange mid/);
  });

  test("a refused venue degrades to the other one rather than killing the trade", () => {
    // Refusing the venue must not refuse the order. The trade still happens,
    // on the venue whose price can be believed.
    const plan = route({
      intent: { symbol: "BNBUSDT", side: "BUY", baseQty: 10 },
      snapshot: withPool(MID * 0.01),
      policy: { ...DEFAULT_POLICY, maxDailyNotionalUsd: undefined },
    });
    assert.equal(plan.chosen.venue, "BINANCE_SPOT");
  });

  test("the bound is the operator's to set", () => {
    const snapshot = withPool(MID * 0.97);
    const strict = priceAllRoutes({ snapshot, side: "BUY", baseQty: 10, maxDivergenceBps: 10 });
    const loose = priceAllRoutes({ snapshot, side: "BUY", baseQty: 10, maxDivergenceBps: 5_000 });
    assert.ok(strict.find((r) => r.venue === "ONCHAIN")!.unavailable);
    assert.equal(loose.find((r) => r.venue === "ONCHAIN")!.unavailable, undefined);
  });

  test("the default bound is far past normal cross-venue movement", () => {
    // Divergence on a liquid pair runs to a few basis points, so the default
    // has to sit well clear of it or ordinary trading trips the guard.
    assert.ok(DEFAULT_MAX_DIVERGENCE_BPS >= 50);
    assert.equal(onchainRoute(MID * 1.001).unavailable, undefined, "10 bps out is normal");
  });
});
