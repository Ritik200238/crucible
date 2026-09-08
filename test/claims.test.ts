/**
 * What an agent may say it did, checked against the ledger.
 *
 * The property under test is not "invention is caught" — that is the easy
 * half. It is that a summary true in every word and false as an account is
 * caught too: the one that reports a quiet day while five orders were refused.
 * And that every refusal comes back with something true to say instead.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { checkClaim } from "../src/ledger/claims.ts";
import type { LedgerRecord } from "../src/ledger/chain.ts";
import type { ConfirmedFill } from "../src/types.ts";

let seq = 0;
function record(kind: string, payload: unknown, at = "2026-09-08T12:00:00.000Z"): LedgerRecord {
  const n = seq++;
  return { seq: n, timestamp: at, kind, payload, prevHash: "0".repeat(64), hash: `a1b2c3d4${String(n).padStart(56, "0")}` };
}

const fill = (over: Partial<ConfirmedFill> = {}): ConfirmedFill => ({
  venue: "BINANCE_SPOT",
  status: "FILLED",
  filledBaseQty: 0.664,
  filledQuoteQty: 499.33,
  avgPrice: 752.0,
  fees: [],
  totalFeeInQuote: 0.4993,
  isMaker: false,
  reference: "5100200",
  confirmedBy: "GET /api/v3/order",
  ...over,
});

const completed = () =>
  record("execution.completed", {
    planId: "fe53499c5cef",
    fingerprint: "fe53499c5cefb250",
    symbol: "BNBUSDT",
    side: "BUY",
    venue: "BINANCE_SPOT",
    fills: [fill()],
    predictedBps: 10.07,
    realisedBps: 10.2137,
    errorBps: 0.1437,
    savingUsd: 0.4364,
    savingBps: 8.7284,
  });

const refused = (reason = "max_order_notional: $50,000 is above your $25,000 per-order cap.") =>
  record("execution.refused", { planId: "0badcafe1234", fingerprint: "0badcafe12345678", reason });

const unconfirmed = () =>
  record("execution.unconfirmed", {
    planId: "deadbeef0001",
    fingerprint: "deadbeef00010002",
    symbol: "BNBUSDT",
    side: "BUY",
    mid: 752,
    predictedBps: 10,
    submitted: [{ venue: "BINANCE_SPOT", reference: "5100201", baseQty: 1, quoteQty: 752 }],
    confirmedFills: [],
    reason: "read-back timed out",
  });

describe("figures must be vouched for by a record", () => {
  test("a figure a record carries, at the precision written, is grounded", () => {
    const r = checkClaim("Bought 0.664 BNB for $499.33; saved 8.73 bps.", [completed()]);
    assert.equal(r.ok, true, JSON.stringify(r.problems));
    assert.deepEqual(
      r.grounded.map((g) => [g.figure, g.field]),
      [
        ["0.664", "fills[0].filledBaseQty"],
        ["$499.33", "fills[0].filledQuoteQty"],
        ["8.73", "savingBps"],
      ],
    );
  });

  test("coarser precision is fine when the record rounds to it", () => {
    const r = checkClaim("Bought about 0.66 BNB for roughly $499 and saved 9 bps.", [completed()]);
    assert.equal(r.ok, true, JSON.stringify(r.problems));
  });

  test("a figure no record carries is refused", () => {
    // 8.9 bps is close. It is not what happened, and "close" is how a number
    // drifts a little every time it is repeated.
    const r = checkClaim("Bought 0.664 BNB and saved 8.9 bps.", [completed()]);
    assert.equal(r.ok, false);
    assert.equal(r.problems[0]!.kind, "ungrounded_figure");
    assert.match(r.problems[0]!.detail, /8\.9/);
  });

  test("a tolerance band is not used: 80,500 is not grounded by 80,127.99", () => {
    const r = checkClaim("Filled at 80,500.", [record("execution.completed", { fills: [fill({ avgPrice: 80_127.99 })], side: "BUY", symbol: "BTCUSDT" })]);
    assert.equal(r.ok, false);
    assert.equal(r.problems[0]!.kind, "ungrounded_figure");
    // While 80,128 and 80.1k both are, because the record rounds to them.
    assert.equal(checkClaim("Filled at 80,128.", [record("execution.completed", { fills: [fill({ avgPrice: 80_127.99 })], side: "BUY", symbol: "BTCUSDT" })]).ok, true);
    assert.equal(checkClaim("Filled at 80.1k.", [record("execution.completed", { fills: [fill({ avgPrice: 80_127.99 })], side: "BUY", symbol: "BTCUSDT" })]).ok, true);
  });

  test("a count of what happened grounds a small integer", () => {
    const r = checkClaim("2 orders were refused today.", [refused(), refused("cooldown")]);
    assert.equal(r.problems.some((p) => p.kind === "ungrounded_figure"), false, JSON.stringify(r.problems));
  });

  test("a plan id or reference that is not on the record is refused", () => {
    const r = checkClaim("Executed plan 1234abcd9999 (ref 5100200).", [completed()]);
    assert.ok(r.problems.some((p) => p.kind === "ungrounded_reference" && /1234abcd9999/.test(p.detail)));
    // The real plan id, even shortened, passes.
    assert.equal(checkClaim("Executed plan fe53499c5cef, ref 5100200.", [completed()]).ok, true);
  });
});

describe("execution claims need a confirmed fill", () => {
  test("a fill that never happened cannot be reported as done", () => {
    const r = checkClaim("Bought $500 of BNB at 752.", [refused()]);
    assert.ok(r.problems.some((p) => p.kind === "execution_not_confirmed"));
    assert.match(r.problems.find((p) => p.kind === "execution_not_confirmed")!.detail, /refused or failed/);
  });

  test("nothing sent at all is said plainly", () => {
    const r = checkClaim("I executed the trade.", []);
    assert.ok(r.problems.some((p) => p.kind === "execution_not_confirmed" && /Nothing was sent/.test(p.detail)));
  });

  test("an unresolved order is not done, and is named as unresolved", () => {
    const r = checkClaim("Bought 1 BNB.", [unconfirmed()]);
    assert.ok(r.problems.some((p) => p.kind === "unresolved_described_as_done"));
  });

  test("a fill confirmed late by reconciliation counts", () => {
    const r = checkClaim("Bought 0.664 BNB.", [
      record("execution.reconciled", { planId: "p", symbol: "BNBUSDT", side: "BUY", outcome: "filled", fills: [fill()] }),
    ]);
    assert.equal(r.ok, true, JSON.stringify(r.problems));
  });
});

describe("omission is the lie a word-by-word check cannot see", () => {
  test("a quiet-day summary that hides a refusal is refused", () => {
    // True in every word. Materially false.
    const r = checkClaim("I reviewed the market and took no action today.", [refused(), refused("daily_loss_limit")]);
    assert.equal(r.ok, false);
    assert.equal(r.problems[0]!.kind, "omitted_refusal");
    assert.match(r.problems[0]!.detail, /2 order\(s\) were refused/);
  });

  test("mentioning the refusal clears it", () => {
    const r = checkClaim("Two orders were refused by the per-order cap; nothing was sent.", [refused(), refused()]);
    assert.equal(r.ok, true, JSON.stringify(r.problems));
  });

  test("an unresolved order must be mentioned", () => {
    const r = checkClaim("Nothing to report.", [unconfirmed()]);
    assert.ok(r.problems.some((p) => p.kind === "omitted_unresolved"));
    assert.equal(checkClaim("One order is unresolved: sent, not yet confirmed.", [unconfirmed()]).ok, true);
  });

  test("a resolved order no longer needs mentioning", () => {
    const records = [unconfirmed(), record("execution.reconciled", { planId: "deadbeef0001", outcome: "never_filled", fills: [] })];
    const r = checkClaim("Nothing was executed today.", records);
    assert.equal(r.problems.some((p) => p.kind === "omitted_unresolved"), false, JSON.stringify(r.problems));
  });
});

describe("things no record can support", () => {
  test("a forecast is refused", () => {
    const r = checkClaim("BNB will rise from here.", [completed()]);
    assert.ok(r.problems.some((p) => p.kind === "forecast"));
  });

  test("advice is refused", () => {
    const r = checkClaim("You should buy more BNB now.", []);
    assert.ok(r.problems.some((p) => p.kind === "advice"));
  });

  test("ordinary future tense about the system is not a forecast", () => {
    const r = checkClaim("The plan will expire in 60 seconds.", []);
    assert.equal(r.problems.some((p) => p.kind === "forecast"), false);
  });
});

describe("every refusal comes with something true to say", () => {
  test("the replacement is built from the records, and only from them", () => {
    const r = checkClaim("Bought $600 of BNB and saved 12 bps.", [completed(), refused()]);
    assert.equal(r.ok, false);
    assert.match(r.replacement, /BUY 0\.664000 on BNBUSDT via BINANCE_SPOT for \$499\.33/);
    assert.match(r.replacement, /predicted 10\.07 bps, realised 10\.21 bps/);
    assert.match(r.replacement, /\$0\.44 against the next best route/);
    assert.match(r.replacement, /Refused: max_order_notional/);
    // The replacement itself passes the check it was born from.
    assert.equal(checkClaim(r.replacement, [completed(), refused()]).ok, true);
  });

  test("with nothing on the record, the replacement says so", () => {
    const r = checkClaim("Made three trades.", []);
    assert.match(r.replacement, /No order was executed/);
    assert.match(r.replacement, /holds no records/);
  });

  test("an unresolved order is described as held, not as done and not as failed", () => {
    const r = checkClaim("", [unconfirmed()]);
    assert.match(r.replacement, /Unresolved: plan deadbeef0001/);
    assert.match(r.replacement, /held against the caps/);
  });

  test("the window can be limited to recent records", () => {
    const old = refused();
    old.timestamp = "2026-09-01T00:00:00.000Z";
    const r = checkClaim("Nothing was sent today.", [old], { since: Date.parse("2026-09-08T00:00:00.000Z") });
    assert.equal(r.problems.some((p) => p.kind === "omitted_refusal"), false);
  });
});
