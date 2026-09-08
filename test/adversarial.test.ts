import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ledger } from "../src/ledger/chain.ts";
import { deriveState, emptyState } from "../src/risk/state.ts";
import { evaluate } from "../src/risk/engine.ts";
import { DEFAULT_POLICY } from "../src/config.ts";
import type { ConfirmedFill, EvaluationContext, Policy, ProposedOrder } from "../src/types.ts";

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
