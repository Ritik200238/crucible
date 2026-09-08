/**
 * Calibration reads the ledger and says how wrong the cost model has been.
 *
 * The tests that matter here are not the arithmetic ones — they are the tests
 * that the report refuses to sound confident. A calibration report is the piece
 * of this product most likely to be quoted back as proof that it works, so the
 * failure worth guarding against is it producing a reassuring number out of
 * nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { calibration } from "../src/exec/calibration.ts";
import type { LedgerRecord } from "../src/ledger/chain.ts";

let seq = 0;
function record(kind: string, payload: unknown): LedgerRecord {
  const n = seq++;
  return {
    seq: n,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
    kind,
    payload,
    prevHash: "0".repeat(64),
    hash: String(n).padStart(64, "0"),
  };
}

function completed(predicted: number, realised: number, venue = "BINANCE_SPOT") {
  return record("execution.completed", {
    venue,
    predictedBps: predicted,
    realisedBps: realised,
    errorBps: realised - predicted,
  });
}

test("an empty ledger says the model has never been graded, not that it is accurate", () => {
  const report = calibration([]);

  assert.equal(report.samples, 0);
  assert.equal(report.meanErrorBps, null);
  assert.equal(report.meanAbsErrorBps, null);
  assert.deepEqual(report.points, []);

  // The specific failure being guarded against: a report that reads as good
  // news because no bad news has been recorded yet.
  assert.match(report.verdict, /never been checked/i);
  assert.match(report.verdict, /not yet been graded/i);
  assert.doesNotMatch(report.verdict, /accurate|reliable|within|good/i);
});

test("routing decisions and other records are not mistaken for executions", () => {
  const report = calibration([
    record("route.decided", { predictedBps: 10, realisedBps: 12, errorBps: 2 }),
    record("policy.loaded", { rules: 17 }),
    record("execution.blocked", { reason: "max_order_notional" }),
  ]);

  // A route that was decided but never executed carries a prediction and no
  // outcome. Counting it would grade the model against its own guess.
  assert.equal(report.samples, 0);
  assert.equal(report.incomparable, 0);
});

test("an execution whose cost could not be completed is counted as incomparable, not as a hit", () => {
  const report = calibration([
    record("execution.completed", { venue: "BINANCE_SPOT", predictedBps: 10, realisedBps: null, errorBps: null }),
    record("execution.completed", { venue: "BINANCE_SPOT", predictedBps: 10 }),
  ]);

  assert.equal(report.samples, 0);
  assert.equal(report.incomparable, 2);
  assert.match(report.verdict, /none produced a comparable cost/i);
  assert.match(report.verdict, /nothing here should be read as evidence/i);
});

test("error is signed so that under-prediction is distinguishable from over-prediction", () => {
  // Both trades missed by 3 bps, in opposite directions. A model graded on
  // absolute error alone would call this pair perfect on average; it is not,
  // and the sign is the half that says whether trades cost more than promised.
  const report = calibration([completed(10, 13), completed(10, 7)]);

  assert.equal(report.samples, 2);
  assert.equal(report.meanErrorBps, 0);
  assert.equal(report.meanAbsErrorBps, 3);
  assert.equal(report.worstErrorBps !== null && Math.abs(report.worstErrorBps), 3);
});

test("a good average cannot hide a bad tail", () => {
  const report = calibration([completed(10, 10), completed(10, 10), completed(10, 10), completed(10, 40)]);

  assert.equal(report.meanErrorBps, 7.5);
  // The worst miss is reported separately and keeps its sign, so a single
  // 30 bps failure stays visible next to an average that looks survivable.
  assert.equal(report.worstErrorBps, 30);
});

test("fewer than five executions refuses to describe a tendency", () => {
  const report = calibration([completed(10, 20), completed(10, 20), completed(10, 20), completed(10, 20)]);

  assert.equal(report.samples, 4);
  // The bias is enormous and perfectly consistent. It still does not mean
  // anything at this sample count, and the wording has to say so.
  assert.equal(report.meanErrorBps, 10);
  assert.match(report.verdict, /far too few/i);
  assert.match(report.verdict, /not what tends to happen/i);
});

test("between five and thirty executions admits it cannot rule out a small bias", () => {
  const report = calibration(Array.from({ length: 8 }, () => completed(10, 12)));

  assert.equal(report.samples, 8);
  assert.match(report.verdict, /not to rule out a small one/i);
  assert.match(report.verdict, /2\.00 bps more than predicted/);
});

test("errors are attributed to the venue that produced them", () => {
  const report = calibration([
    completed(10, 12, "BINANCE_SPOT"),
    completed(10, 14, "BINANCE_SPOT"),
    completed(5, 4, "ONCHAIN"),
  ]);

  // A model that is unbiased overall can still be wrong on one venue and wrong
  // the other way on the other. Pooling them would hide exactly that.
  assert.deepEqual(report.byVenue, [
    { venue: "BINANCE_SPOT", samples: 2, meanErrorBps: 3 },
    { venue: "ONCHAIN", samples: 1, meanErrorBps: -1 },
  ]);
});

test("an execution recorded before venues were tracked is labelled rather than dropped", () => {
  const report = calibration([
    record("execution.completed", { predictedBps: 10, realisedBps: 11, errorBps: 1 }),
  ]);

  assert.equal(report.samples, 1);
  assert.equal(report.points[0]!.venue, "UNKNOWN");
});

test("the median resists a single outlier that drags the mean", () => {
  const report = calibration([
    completed(10, 11),
    completed(10, 11),
    completed(10, 11),
    completed(10, 11),
    completed(10, 511),
  ]);

  assert.equal(report.medianErrorBps, 1);
  assert.equal(report.meanErrorBps, 101);
});

test("an even number of samples takes the midpoint of the two middle errors", () => {
  const report = calibration([completed(10, 11), completed(10, 14)]);
  assert.equal(report.medianErrorBps, 2.5);
});
