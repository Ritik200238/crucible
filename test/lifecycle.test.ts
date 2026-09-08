/**
 * What the ledger says while an order's outcome is unknown, and how it is closed.
 *
 * Three states, and the gap between them is where money gets lost:
 *
 *   failed       nothing reached a venue — may be retried
 *   unconfirmed  something reached a venue and was not read back — must not be
 *   reconciled   the venue was asked again and answered
 *
 * The property under test is that not knowing is never treated as knowing it
 * did not happen. An unconfirmed order holds its notional, counts as an order,
 * and stays that way until a reconciliation says otherwise — because a system
 * that frees budget on a timeout is a system that a slow network can make
 * forget an order.
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ledger, ledgerPaths } from "../src/ledger/chain.ts";
import { deriveState } from "../src/risk/state.ts";
import { reconcile, ExecutionError } from "../src/exec/execute.ts";
import { calibration } from "../src/exec/calibration.ts";
import type { Credentials } from "../src/exec/binance-rest.ts";
import type { SwapOrder } from "../src/exec/wallet.ts";
import type { ConfirmedFill, SymbolFilters } from "../src/types.ts";

const dirs: string[] = [];
function tempLedger(): Ledger {
  const dir = mkdtempSync(join(tmpdir(), "crucible-lifecycle-"));
  dirs.push(dir);
  return new Ledger({ dir });
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const FILTERS: SymbolFilters = {
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
};

const CREDS: Credentials = { apiKey: "k", secret: "s", scheme: "HMAC" };
const MID = 750;

const fill = (over: Partial<ConfirmedFill> = {}): ConfirmedFill => ({
  venue: "BINANCE_SPOT",
  status: "FILLED",
  filledBaseQty: 2,
  filledQuoteQty: 1500,
  avgPrice: 750,
  fees: [],
  totalFeeInQuote: 0,
  isMaker: false,
  reference: "1",
  confirmedBy: "test",
  ...over,
});

/** An unconfirmed record as execute() writes it when the read-back dies. */
function unconfirmed(
  ledger: Ledger,
  planId: string,
  over: Partial<{
    venue: "BINANCE_SPOT" | "ONCHAIN";
    reference: string;
    baseQty: number;
    quoteQty: number;
    confirmedFills: ConfirmedFill[];
    predictedBps: number;
  }> = {},
) {
  const venue = over.venue ?? "BINANCE_SPOT";
  return ledger.append("execution.unconfirmed", {
    planId,
    fingerprint: `fp-${planId}`,
    symbol: "BNBUSDT",
    side: "BUY",
    mid: MID,
    predictedBps: over.predictedBps ?? 10,
    submitted: [
      {
        venue,
        reference: over.reference ?? "5100200",
        baseQty: over.baseQty ?? 2,
        quoteQty: over.quoteQty ?? 1500,
      },
    ],
    confirmedFills: over.confirmedFills ?? [],
    reason: "read-back timed out",
  });
}

/** A fetch that answers the exchange's read-back with a chosen order status. */
function exchangeSaying(status: string, executedQty = "2.00000000") {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    calls.push(`${url.pathname}`);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

    if (url.pathname === "/api/v3/time") return json({ serverTime: Date.now() });
    if (url.pathname === "/api/v3/order") {
      return json({
        symbol: "BNBUSDT",
        orderId: Number(url.searchParams.get("orderId")),
        clientOrderId: "cru-x-0",
        transactTime: Date.now(),
        price: "0.00000000",
        origQty: "2.00000000",
        executedQty,
        cummulativeQuoteQty: String(Number(executedQty) * 751),
        status,
        type: "MARKET",
        side: "BUY",
      });
    }
    if (url.pathname === "/api/v3/myTrades") {
      if (Number(executedQty) === 0) return json([]);
      return json([
        {
          id: 1,
          orderId: Number(url.searchParams.get("orderId")),
          price: "751.00000000",
          qty: executedQty,
          quoteQty: String(Number(executedQty) * 751),
          commission: "1.50200000",
          commissionAsset: "USDT",
          isMaker: false,
          time: Date.now(),
        },
      ]);
    }
    return json({ code: -1121, msg: `no route for ${url.pathname}` });
  };
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------

describe("an unconfirmed order holds its place against the caps", () => {
  test("its notional and its order count are reserved from the moment it was sent", () => {
    const ledger = tempLedger();
    unconfirmed(ledger, "p1", { quoteQty: 1500 });

    const state = deriveState(ledger.read());
    assert.equal(state.notionalTodayUsd, 1500);
    assert.equal(state.ordersToday, 1);
    assert.equal(state.recentOrderTimes.length, 1);
    assert.deepEqual(
      state.unresolved.map((u) => [u.planId, u.reference, u.quoteQty]),
      [["p1", "5100200", 1500]],
    );
  });

  test("the hold is not released by time passing, only by an answer", () => {
    // The attack this pins: send an order, cut the read-back, wait, send
    // again. Without the hold the second order is judged as if the first had
    // never happened.
    const ledger = tempLedger();
    unconfirmed(ledger, "p1", { quoteQty: 60_000 });
    unconfirmed(ledger, "p2", { reference: "5100201", quoteQty: 60_000 });

    const state = deriveState(ledger.read());
    assert.equal(state.notionalTodayUsd, 120_000);
    assert.equal(state.unresolved.length, 2);
  });

  test("fills that confirmed before a plan failed are still counted", () => {
    // Slice one filled; slice two was refused at validation. The plan failed,
    // and $750 of it is nonetheless real.
    const ledger = tempLedger();
    ledger.append("execution.failed", {
      planId: "p1",
      fingerprint: "fp",
      symbol: "BNBUSDT",
      side: "BUY",
      reason: "slice 2 rejected by the exchange's filters",
      confirmedFills: [fill({ filledBaseQty: 1, filledQuoteQty: 750, reference: "a" })],
    });

    const state = deriveState(ledger.read());
    assert.equal(state.notionalTodayUsd, 750);
    assert.equal(state.ordersToday, 1);
    assert.equal(state.unresolved.length, 0, "a failure with nothing in flight holds nothing");
  });

  test("an unconfirmed plan counts its confirmed slices and holds its unresolved one", () => {
    const ledger = tempLedger();
    unconfirmed(ledger, "p1", {
      quoteQty: 750,
      confirmedFills: [fill({ filledBaseQty: 1, filledQuoteQty: 750, reference: "a" })],
    });

    const state = deriveState(ledger.read());
    assert.equal(state.notionalTodayUsd, 1500, "$750 confirmed plus $750 held");
    assert.equal(state.ordersToday, 2);
  });
});

describe("reconciliation closes the unknown with the venue's own answer", () => {
  test("a filled order is booked as a fill and releases its hold", async () => {
    const ledger = tempLedger();
    unconfirmed(ledger, "p1", { quoteQty: 1500, predictedBps: 10 });
    const venue = exchangeSaying("FILLED");

    const result = await reconcile({
      planId: "p1",
      ledger,
      binance: { baseUrl: "https://venue.invalid", credentials: CREDS, fetchImpl: venue.fetchImpl },
      filters: FILTERS,
    });

    assert.equal(result.outcome, "filled");
    assert.equal(result.fills.length, 1);
    assert.equal(result.fills[0]!.status, "FILLED");
    // Read back, never assumed: the order and its trades were both fetched.
    assert.ok(venue.calls.includes("/api/v3/order"));
    assert.ok(venue.calls.includes("/api/v3/myTrades"));

    // Bought at 751 against a mid of 750 is 13.33 bps gross, plus 10 bps fee.
    assert.ok(result.realisedBps !== null && result.realisedBps > 20 && result.realisedBps < 25, `got ${result.realisedBps}`);
    assert.ok(result.errorBps !== null && result.errorBps > 10, "the model under-predicted, and the error says so");

    const kinds = ledger.read().map((r) => r.kind);
    assert.deepEqual(kinds, ["execution.unconfirmed", "execution.reconciled"]);

    const state = deriveState(ledger.read());
    assert.equal(state.unresolved.length, 0, "the hold is released");
    // The fill now counts at what actually traded, not at the held estimate.
    assert.equal(state.ordersToday, 1);
    assert.ok(Math.abs(state.notionalTodayUsd - 1502) < 0.01, `got ${state.notionalTodayUsd}`);
  });

  test("an order the venue says never filled releases its hold and books nothing", async () => {
    const ledger = tempLedger();
    unconfirmed(ledger, "p1", { quoteQty: 1500 });
    const venue = exchangeSaying("CANCELED", "0.00000000");

    const result = await reconcile({
      planId: "p1",
      ledger,
      binance: { baseUrl: "https://venue.invalid", credentials: CREDS, fetchImpl: venue.fetchImpl },
      filters: FILTERS,
    });

    assert.equal(result.outcome, "never_filled");
    const state = deriveState(ledger.read());
    assert.equal(state.unresolved.length, 0);
    assert.equal(state.notionalTodayUsd, 0);
    assert.equal(state.ordersToday, 0);
  });

  test("an order still open at the venue keeps its hold and records the attempt", async () => {
    const ledger = tempLedger();
    unconfirmed(ledger, "p1", { quoteQty: 1500 });
    const venue = exchangeSaying("NEW", "0.00000000");

    const result = await reconcile({
      planId: "p1",
      ledger,
      binance: { baseUrl: "https://venue.invalid", credentials: CREDS, fetchImpl: venue.fetchImpl },
      filters: FILTERS,
    });

    assert.equal(result.outcome, "still_unresolved");
    assert.deepEqual(result.stillOpen, ["5100200"]);
    assert.deepEqual(
      ledger.read().map((r) => r.kind),
      ["execution.unconfirmed", "execution.reconcile_attempted"],
    );
    // Still unknown, still held.
    const state = deriveState(ledger.read());
    assert.equal(state.unresolved.length, 1);
    assert.equal(state.notionalTodayUsd, 1500);
  });

  test("an on-chain swap is read back through the wallet, not the exchange", async () => {
    const ledger = tempLedger();
    unconfirmed(ledger, "p1", { venue: "ONCHAIN", reference: "swap-77", baseQty: 2, quoteQty: 1500 });
    const asked: string[] = [];
    const swapLookup = async (id: string): Promise<SwapOrder> => {
      asked.push(id);
      return {
        orderId: id,
        status: "FINISHED",
        txHash: "0xabc",
        fromTokenQty: 1502,
        toTokenQty: 2,
        fromTokenName: "USDT",
        toTokenName: "BNB",
      };
    };

    const result = await reconcile({ planId: "p1", ledger, swapLookup });

    assert.deepEqual(asked, ["swap-77"]);
    assert.equal(result.outcome, "filled");
    assert.equal(result.fills[0]!.venue, "ONCHAIN");
    assert.equal(result.fills[0]!.reference, "0xabc");
    assert.equal(deriveState(ledger.read()).unresolved.length, 0);
  });

  test("a reconciled fill is graded by calibration like any other", async () => {
    // The whole point of closing the unknown: a late answer is still an answer
    // about how good the prediction was.
    const ledger = tempLedger();
    unconfirmed(ledger, "p1", { predictedBps: 10 });
    const venue = exchangeSaying("FILLED");
    await reconcile({
      planId: "p1",
      ledger,
      binance: { baseUrl: "https://venue.invalid", credentials: CREDS, fetchImpl: venue.fetchImpl },
      filters: FILTERS,
    });

    const report = calibration(ledger.read());
    assert.equal(report.samples, 1);
    assert.ok(report.points[0]!.errorBps > 10);
  });

  test("a plan with nothing unresolved cannot be reconciled", async () => {
    const ledger = tempLedger();
    await assert.rejects(reconcile({ planId: "nope", ledger }), ExecutionError);
  });

  test("reconciling twice does not double-book", async () => {
    const ledger = tempLedger();
    unconfirmed(ledger, "p1");
    const venue = exchangeSaying("FILLED");
    const opts = {
      planId: "p1",
      ledger,
      binance: { baseUrl: "https://venue.invalid", credentials: CREDS, fetchImpl: venue.fetchImpl },
      filters: FILTERS,
    };
    await reconcile(opts);
    await assert.rejects(reconcile(opts), /already been reconciled|no unresolved/);
    assert.equal(deriveState(ledger.read()).ordersToday, 1);
  });

  test("an exchange order cannot be reconciled without credentials to read it", async () => {
    const ledger = tempLedger();
    unconfirmed(ledger, "p1");
    await assert.rejects(reconcile({ planId: "p1", ledger }), /credentials/);
    // Refusing to look is not an answer: the hold stays.
    assert.equal(deriveState(ledger.read()).unresolved.length, 1);
  });
});

describe("where the ledger lives", () => {
  test("CRUCIBLE_LEDGER_DIR moves it, and is read per call", () => {
    // A hosted instance needs this: a serverless bundler will not carry a
    // dot-directory, so the deployed copy sits somewhere ordinary.
    const saved = process.env.CRUCIBLE_LEDGER_DIR;
    try {
      delete process.env.CRUCIBLE_LEDGER_DIR;
      assert.match(ledgerPaths().dir, /\.crucible$/);

      process.env.CRUCIBLE_LEDGER_DIR = "deploy/ledger";
      assert.match(ledgerPaths().dir.replace(/\\/g, "/"), /deploy\/ledger$/);
      assert.match(ledgerPaths().ledger.replace(/\\/g, "/"), /deploy\/ledger\/ledger\.jsonl$/);

      // A blank value is not a directory.
      process.env.CRUCIBLE_LEDGER_DIR = "   ";
      assert.match(ledgerPaths().dir, /\.crucible$/);
    } finally {
      if (saved === undefined) delete process.env.CRUCIBLE_LEDGER_DIR;
      else process.env.CRUCIBLE_LEDGER_DIR = saved;
    }
  });

  test("an explicit directory still wins over the variable", () => {
    const saved = process.env.CRUCIBLE_LEDGER_DIR;
    try {
      process.env.CRUCIBLE_LEDGER_DIR = "deploy/ledger";
      assert.match(ledgerPaths("somewhere/else").dir.replace(/\\/g, "/"), /somewhere\/else$/);
    } finally {
      if (saved === undefined) delete process.env.CRUCIBLE_LEDGER_DIR;
      else process.env.CRUCIBLE_LEDGER_DIR = saved;
    }
  });
});
