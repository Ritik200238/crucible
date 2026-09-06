import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  cooldownAfterLoss,
  dailyLossLimit,
  inWindow,
  maxLeverage,
  maxOrderNotional,
  maxOrdersPerHour,
  maxPositionConcentration,
  noTradeWindows,
  orderNotionalUsd,
  reducesRisk,
  symbolPermitted,
} from "../src/policy/rules.ts";
import type {
  EvaluationContext,
  Policy,
  ProposedOrder,
} from "../src/types.ts";

const NOW = new Date("2026-09-06T10:00:00.000Z");

function ctx(policy: Policy, over: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    policy,
    account: { equityUsd: 10_000, positions: [], realisedPnlTodayUsd: 0, source: "simulated" },
    state: {
      day: "2026-09-06",
      notionalTodayUsd: 0,
      ordersToday: 0,
      recentOrderTimes: [],
      lastLossAt: null,
      realisedPnlTodayUsd: 0,
    },
    markPrice: 80_000,
    now: NOW,
    ...over,
  };
}

const buy = (over: Partial<ProposedOrder> = {}): ProposedOrder => ({
  symbol: "BTCUSDT",
  side: "BUY",
  type: "MARKET",
  market: "SPOT",
  quoteOrderQty: 100,
  ...over,
});

describe("orderNotionalUsd", () => {
  test("takes quoteOrderQty at face value", () => {
    assert.equal(orderNotionalUsd(buy({ quoteOrderQty: 250 }), 80_000), 250);
  });

  test("converts base quantity at the mark price", () => {
    const o = buy({ quoteOrderQty: undefined, quantity: 0.5 });
    assert.equal(orderNotionalUsd(o, 80_000), 40_000);
  });

  test("a LIMIT order is priced at its own limit price, not the mark", () => {
    const o = buy({ quoteOrderQty: undefined, quantity: 1, type: "LIMIT", price: 70_000 });
    assert.equal(orderNotionalUsd(o, 80_000), 70_000);
  });
});

describe("reducesRisk", () => {
  test("reduceOnly futures orders reduce risk", () => {
    assert.equal(reducesRisk(buy({ market: "USDM_FUTURES", reduceOnly: true })), true);
  });

  test("a spot sell reduces risk", () => {
    assert.equal(reducesRisk(buy({ side: "SELL" })), true);
  });

  test("a spot buy does not", () => {
    assert.equal(reducesRisk(buy()), false);
  });
});

describe("maxOrderNotional", () => {
  const policy: Policy = { version: 1, mode: "dry-run", maxOrderNotionalUsd: 500 };

  test("allows an order at the cap", () => {
    const r = maxOrderNotional.evaluate(buy({ quoteOrderQty: 500 }), ctx(policy));
    assert.equal(r?.verdict, "ALLOW");
  });

  test("blocks a cent over the cap", () => {
    const r = maxOrderNotional.evaluate(buy({ quoteOrderQty: 500.01 }), ctx(policy));
    assert.equal(r?.verdict, "BLOCK");
  });

  test("is inert when unconfigured", () => {
    const r = maxOrderNotional.evaluate(buy(), ctx({ version: 1, mode: "dry-run" }));
    assert.equal(r, null);
  });
});

describe("maxLeverage", () => {
  const policy: Policy = { version: 1, mode: "dry-run", maxLeverage: 5 };

  test("blocks above the cap", () => {
    const o = buy({ market: "USDM_FUTURES", leverage: 20 });
    assert.equal(maxLeverage.evaluate(o, ctx(policy))?.verdict, "BLOCK");
  });

  test("allows at the cap", () => {
    const o = buy({ market: "USDM_FUTURES", leverage: 5 });
    assert.equal(maxLeverage.evaluate(o, ctx(policy))?.verdict, "ALLOW");
  });

  test("does not apply when the order names no leverage", () => {
    assert.equal(maxLeverage.evaluate(buy(), ctx(policy)), null);
  });
});

describe("maxPositionConcentration", () => {
  const policy: Policy = { version: 1, mode: "dry-run", maxPositionPctOfEquity: 20 };

  test("counts existing exposure toward the cap", () => {
    const c = ctx(policy, {
      account: {
        equityUsd: 10_000,
        positions: [{ symbol: "BTCUSDT", notionalUsd: 1_900 }],
        realisedPnlTodayUsd: 0,
        source: "simulated",
      },
    });
    // 1,900 held + 200 new = 2,100 = 21% of equity, over the 20% cap.
    assert.equal(maxPositionConcentration.evaluate(buy({ quoteOrderQty: 200 }), c)?.verdict, "BLOCK");
  });

  test("ignores exposure in a different symbol", () => {
    const c = ctx(policy, {
      account: {
        equityUsd: 10_000,
        positions: [{ symbol: "ETHUSDT", notionalUsd: 5_000 }],
        realisedPnlTodayUsd: 0,
        source: "simulated",
      },
    });
    assert.equal(maxPositionConcentration.evaluate(buy({ quoteOrderQty: 200 }), c)?.verdict, "ALLOW");
  });

  test("never blocks a risk-reducing order", () => {
    const c = ctx(policy, {
      account: {
        equityUsd: 1_000,
        positions: [{ symbol: "BTCUSDT", notionalUsd: 900 }],
        realisedPnlTodayUsd: 0,
        source: "simulated",
      },
    });
    const r = maxPositionConcentration.evaluate(buy({ side: "SELL", quoteOrderQty: 900 }), c);
    assert.equal(r?.verdict, "ALLOW");
    assert.match(r!.message, /reduces exposure/);
  });
});

describe("dailyLossLimit", () => {
  const policy: Policy = { version: 1, mode: "dry-run", dailyLossLimitPct: 2 };

  const downBy = (usd: number) =>
    ctx(policy, {
      state: {
        day: "2026-09-06",
        notionalTodayUsd: 0,
        ordersToday: 0,
        recentOrderTimes: [],
        lastLossAt: null,
        realisedPnlTodayUsd: -usd,
      },
    });

  test("allows new risk while inside the limit", () => {
    assert.equal(dailyLossLimit.evaluate(buy(), downBy(150))?.verdict, "ALLOW");
  });

  test("blocks new risk once the limit is reached", () => {
    assert.equal(dailyLossLimit.evaluate(buy(), downBy(200))?.verdict, "BLOCK");
  });

  test("still lets you close a position after the halt", () => {
    const r = dailyLossLimit.evaluate(buy({ side: "SELL" }), downBy(500));
    assert.equal(r?.verdict, "ALLOW", "you must always be able to get out");
  });

  test("a profitable day is never treated as a loss", () => {
    const c = ctx(policy, {
      state: {
        day: "2026-09-06",
        notionalTodayUsd: 0,
        ordersToday: 0,
        recentOrderTimes: [],
        lastLossAt: null,
        realisedPnlTodayUsd: 5_000,
      },
    });
    assert.equal(dailyLossLimit.evaluate(buy(), c)?.verdict, "ALLOW");
  });
});

describe("cooldownAfterLoss", () => {
  const policy: Policy = { version: 1, mode: "dry-run", cooldownAfterLossMinutes: 30 };

  const lostAgo = (min: number) =>
    ctx(policy, {
      state: {
        day: "2026-09-06",
        notionalTodayUsd: 0,
        ordersToday: 0,
        recentOrderTimes: [],
        lastLossAt: new Date(NOW.getTime() - min * 60_000).toISOString(),
        realisedPnlTodayUsd: -100,
      },
    });

  test("blocks inside the cooldown", () => {
    assert.equal(cooldownAfterLoss.evaluate(buy(), lostAgo(10))?.verdict, "BLOCK");
  });

  test("allows once it has elapsed", () => {
    assert.equal(cooldownAfterLoss.evaluate(buy(), lostAgo(31))?.verdict, "ALLOW");
  });

  test("does not trap you in the position", () => {
    assert.equal(cooldownAfterLoss.evaluate(buy({ side: "SELL" }), lostAgo(1))?.verdict, "ALLOW");
  });

  test("is inert with no recorded loss", () => {
    assert.equal(cooldownAfterLoss.evaluate(buy(), ctx(policy)), null);
  });
});

describe("maxOrdersPerHour", () => {
  const policy: Policy = { version: 1, mode: "dry-run", maxOrdersPerHour: 3 };

  const withOrders = (agesMin: number[]) =>
    ctx(policy, {
      state: {
        day: "2026-09-06",
        notionalTodayUsd: 0,
        ordersToday: agesMin.length,
        recentOrderTimes: agesMin.map((m) => new Date(NOW.getTime() - m * 60_000).toISOString()),
        lastLossAt: null,
        realisedPnlTodayUsd: 0,
      },
    });

  test("blocks at the cap", () => {
    assert.equal(maxOrdersPerHour.evaluate(buy(), withOrders([5, 10, 15]))?.verdict, "BLOCK");
  });

  test("only counts the last hour", () => {
    const r = maxOrdersPerHour.evaluate(buy(), withOrders([5, 10, 90, 120]));
    assert.equal(r?.verdict, "ALLOW");
  });
});

describe("inWindow", () => {
  test("matches inside a same-day window", () => {
    assert.equal(inWindow(new Date("2026-09-06T12:30:00Z"), { start: "12:25", end: "12:35" }), true);
  });

  test("is exclusive of the end minute", () => {
    assert.equal(inWindow(new Date("2026-09-06T12:35:00Z"), { start: "12:25", end: "12:35" }), false);
  });

  test("handles a window that crosses midnight", () => {
    const w = { start: "23:00", end: "01:00" };
    assert.equal(inWindow(new Date("2026-09-06T23:30:00Z"), w), true);
    assert.equal(inWindow(new Date("2026-09-06T00:30:00Z"), w), true);
    assert.equal(inWindow(new Date("2026-09-06T12:00:00Z"), w), false);
  });

  test("rejects a malformed window rather than matching everything", () => {
    assert.equal(inWindow(NOW, { start: "not-a-time", end: "01:00" }), false);
  });
});

describe("noTradeWindows", () => {
  const policy: Policy = {
    version: 1,
    mode: "dry-run",
    noTradeWindowsUtc: [{ start: "09:00", end: "11:00", label: "CPI" }],
  };

  test("blocks a new entry inside the window", () => {
    assert.equal(noTradeWindows.evaluate(buy(), ctx(policy))?.verdict, "BLOCK");
  });

  test("lets you exit inside the window", () => {
    assert.equal(noTradeWindows.evaluate(buy({ side: "SELL" }), ctx(policy))?.verdict, "ALLOW");
  });
});

describe("symbolPermitted", () => {
  test("denylist beats allowlist", () => {
    const policy: Policy = {
      version: 1,
      mode: "dry-run",
      symbolAllowlist: ["BTCUSDT"],
      symbolDenylist: ["BTCUSDT"],
    };
    assert.equal(symbolPermitted.evaluate(buy(), ctx(policy))?.verdict, "BLOCK");
  });

  test("blocks a symbol missing from a non-empty allowlist", () => {
    const policy: Policy = { version: 1, mode: "dry-run", symbolAllowlist: ["ETHUSDT"] };
    assert.equal(symbolPermitted.evaluate(buy(), ctx(policy))?.verdict, "BLOCK");
  });

  test("is case-insensitive", () => {
    const policy: Policy = { version: 1, mode: "dry-run", symbolAllowlist: ["btcusdt"] };
    assert.equal(symbolPermitted.evaluate(buy(), ctx(policy))?.verdict, "ALLOW");
  });
});
