import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  evaluate,
  InvalidOrderError,
  reduceVerdict,
  validateOrder,
} from "../src/policy/engine.ts";
import { ConfigError, parsePolicy, isLiveEnabled, DEFAULT_POLICY } from "../src/config.ts";
import {
  emptyState,
  pruneOrderTimes,
  recordOrder,
  recordPnl,
  rollIfNeeded,
} from "../src/state/store.ts";
import { summarise, toEntry } from "../src/audit.ts";
import type { EvaluationContext, Policy, ProposedOrder, RuleResult } from "../src/types.ts";

const NOW = new Date("2026-09-06T10:00:00.000Z");

const buy = (over: Partial<ProposedOrder> = {}): ProposedOrder => ({
  symbol: "BTCUSDT",
  side: "BUY",
  type: "MARKET",
  market: "SPOT",
  quoteOrderQty: 100,
  ...over,
});

function ctx(policy: Policy): EvaluationContext {
  return {
    policy,
    account: { equityUsd: 10_000, positions: [], realisedPnlTodayUsd: 0, source: "simulated" },
    state: emptyState(NOW),
    markPrice: 80_000,
    now: NOW,
  };
}

describe("validateOrder", () => {
  test("rejects a non-USD quote rather than mispricing it", () => {
    assert.throws(() => validateOrder(buy({ symbol: "ETHBTC" })), InvalidOrderError);
  });

  test("rejects both size fields at once", () => {
    assert.throws(
      () => validateOrder(buy({ quantity: 1, quoteOrderQty: 100 })),
      /exactly one/,
    );
  });

  test("rejects neither size field", () => {
    assert.throws(
      () => validateOrder(buy({ quoteOrderQty: undefined })),
      /exactly one/,
    );
  });

  test("rejects a zero or negative size", () => {
    assert.throws(() => validateOrder(buy({ quoteOrderQty: 0 })), InvalidOrderError);
    assert.throws(() => validateOrder(buy({ quoteOrderQty: -5 })), InvalidOrderError);
  });

  test("requires a price on a LIMIT order", () => {
    assert.throws(() => validateOrder(buy({ type: "LIMIT" })), /needs a price/);
  });

  test("rejects leverage on a spot order", () => {
    assert.throws(() => validateOrder(buy({ leverage: 3 })), /does not apply/);
  });

  test("rejects reduceOnly on a spot order", () => {
    assert.throws(() => validateOrder(buy({ reduceOnly: true })), /does not apply/);
  });

  test("accepts a well-formed order", () => {
    assert.doesNotThrow(() => validateOrder(buy()));
  });
});

describe("reduceVerdict", () => {
  const r = (verdict: RuleResult["verdict"], rule: string): RuleResult => ({
    rule,
    verdict,
    message: "",
  });

  test("one BLOCK outweighs any number of passes", () => {
    const out = reduceVerdict([r("ALLOW", "a"), r("ALLOW", "b"), r("BLOCK", "c")]);
    assert.equal(out.verdict, "BLOCK");
    assert.deepEqual(out.blockedBy, ["c"]);
  });

  test("BLOCK outranks CONFIRM", () => {
    assert.equal(reduceVerdict([r("CONFIRM", "a"), r("BLOCK", "b")]).verdict, "BLOCK");
  });

  test("CONFIRM outranks ALLOW", () => {
    assert.equal(reduceVerdict([r("ALLOW", "a"), r("CONFIRM", "b")]).verdict, "CONFIRM");
  });

  test("all passes means ALLOW", () => {
    assert.equal(reduceVerdict([r("ALLOW", "a")]).verdict, "ALLOW");
  });

  test("no rules at all means ALLOW", () => {
    assert.equal(reduceVerdict([]).verdict, "ALLOW");
  });
});

describe("evaluate", () => {
  test("an empty policy allows anything, and says so honestly", () => {
    const d = evaluate(buy(), ctx({ version: 1, mode: "dry-run" }));
    assert.equal(d.verdict, "ALLOW");
    assert.equal(d.results.length, 0, "no rules configured means no rules reported");
  });

  test("records the price the decision was made against", () => {
    const d = evaluate(buy(), ctx(DEFAULT_POLICY));
    assert.equal(d.markPrice, 80_000);
  });

  test("a blocked order still lists the rules it passed", () => {
    const d = evaluate(buy({ quoteOrderQty: 999_999 }), ctx(DEFAULT_POLICY));
    assert.equal(d.verdict, "BLOCK");
    assert.ok(d.results.some((r) => r.verdict === "ALLOW"));
    assert.ok(d.blockedBy.length > 0);
  });
});

describe("parsePolicy", () => {
  test("rejects an unknown field instead of ignoring it", () => {
    assert.throws(() => parsePolicy({ maxLeverge: 5 }), ConfigError);
  });

  test("the error names the offending key", () => {
    assert.throws(() => parsePolicy({ maxLeverge: 5 }), /maxLeverge/);
  });

  test("rejects a bad mode", () => {
    assert.throws(() => parsePolicy({ mode: "yolo" }), ConfigError);
  });

  test("rejects a non-numeric limit", () => {
    assert.throws(() => parsePolicy({ maxOrderNotionalUsd: "lots" }), ConfigError);
  });

  test("rejects an unknown market", () => {
    assert.throws(() => parsePolicy({ allowedMarkets: ["OPTIONS"] }), /OPTIONS/);
  });

  test("rejects a malformed time window", () => {
    assert.throws(
      () => parsePolicy({ noTradeWindowsUtc: [{ start: "9am", end: "11:00" }] }),
      /HH:MM/,
    );
  });

  test("defaults to dry-run when mode is absent", () => {
    assert.equal(parsePolicy({}).mode, "dry-run");
  });

  test("round-trips a full policy", () => {
    const p = parsePolicy({
      version: 1,
      mode: "live",
      maxLeverage: 5,
      symbolAllowlist: ["BTCUSDT"],
      allowedMarkets: ["SPOT"],
      noTradeWindowsUtc: [{ start: "12:00", end: "13:00", label: "CPI" }],
    });
    assert.equal(p.mode, "live");
    assert.equal(p.maxLeverage, 5);
    assert.deepEqual(p.symbolAllowlist, ["BTCUSDT"]);
    assert.equal(p.noTradeWindowsUtc?.[0]?.label, "CPI");
  });
});

describe("isLiveEnabled", () => {
  test("live mode alone is not enough to transmit", () => {
    delete process.env.GUARDRAIL_LIVE;
    assert.equal(isLiveEnabled({ version: 1, mode: "live" }), false);
  });

  test("the env var alone is not enough either", () => {
    process.env.GUARDRAIL_LIVE = "1";
    assert.equal(isLiveEnabled({ version: 1, mode: "dry-run" }), false);
    delete process.env.GUARDRAIL_LIVE;
  });

  test("both together enable it", () => {
    process.env.GUARDRAIL_LIVE = "1";
    assert.equal(isLiveEnabled({ version: 1, mode: "live" }), true);
    delete process.env.GUARDRAIL_LIVE;
  });
});

describe("state", () => {
  test("rolls the daily counters over at a new UTC day", () => {
    const yesterday = { ...emptyState(NOW), day: "2026-09-05", notionalTodayUsd: 5_000 };
    const rolled = rollIfNeeded(yesterday, NOW);
    assert.equal(rolled.day, "2026-09-06");
    assert.equal(rolled.notionalTodayUsd, 0);
  });

  test("a cooldown survives the day rollover", () => {
    const lastLossAt = "2026-09-05T23:55:00.000Z";
    const yesterday = { ...emptyState(NOW), day: "2026-09-05", lastLossAt };
    assert.equal(rollIfNeeded(yesterday, NOW).lastLossAt, lastLossAt);
  });

  test("prunes order times older than an hour", () => {
    const times = [
      new Date(NOW.getTime() - 30 * 60_000).toISOString(),
      new Date(NOW.getTime() - 90 * 60_000).toISOString(),
      "not-a-date",
    ];
    assert.equal(pruneOrderTimes(times, NOW).length, 1);
  });

  test("recordOrder accumulates notional and count", () => {
    const s = recordOrder(recordOrder(emptyState(NOW), 100, NOW), 250, NOW);
    assert.equal(s.notionalTodayUsd, 350);
    assert.equal(s.ordersToday, 2);
    assert.equal(s.recentOrderTimes.length, 2);
  });

  test("a loss arms the cooldown, a win does not", () => {
    assert.ok(recordPnl(emptyState(NOW), -50, NOW).lastLossAt);
    assert.equal(recordPnl(emptyState(NOW), 50, NOW).lastLossAt, null);
  });

  test("a win does not clear an existing cooldown", () => {
    const afterLoss = recordPnl(emptyState(NOW), -50, NOW);
    const afterWin = recordPnl(afterLoss, 200, NOW);
    assert.equal(afterWin.lastLossAt, afterLoss.lastLossAt);
    assert.equal(afterWin.realisedPnlTodayUsd, 150);
  });
});

describe("audit", () => {
  test("summarises verdicts and blocked notional", () => {
    const blocked = evaluate(buy({ quoteOrderQty: 999_999 }), ctx(DEFAULT_POLICY));
    const allowed = evaluate(buy({ quoteOrderQty: 10 }), ctx(DEFAULT_POLICY));
    const s = summarise([
      toEntry(blocked, { transmitted: false }),
      toEntry(allowed, { transmitted: true, exchangeOrderId: "123" }),
    ]);
    assert.equal(s.total, 2);
    assert.equal(s.blocked, 1);
    assert.equal(s.transmitted, 1);
    assert.equal(s.notionalBlockedUsd, 999_999);
    assert.ok(s.topRules.length > 0);
  });

  test("a dry-run entry is never marked transmitted", () => {
    const d = evaluate(buy({ quoteOrderQty: 10 }), ctx(DEFAULT_POLICY));
    assert.equal(toEntry(d).transmitted, false);
    assert.equal(toEntry(d).exchangeOrderId, null);
  });
});
