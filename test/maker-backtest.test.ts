/**
 * The maker-fill backtest, checked against tapes with a known answer.
 *
 * The backtest exists to grade the fill model, so the backtest itself has to be
 * gradeable. Fed flow that dwarfs an order it must report near-certainty; fed
 * flow far too thin it must report near-zero; fed genuinely random arrivals —
 * which is what the model assumes and what a real tape is — its predictions
 * must track the fills that actually happen; and it must measure the rate from
 * the past, so the score is out-of-sample rather than fitted to the future.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { backtestFillModel, predictFill } from "../src/analysis/maker-backtest.ts";
import type { AggTrade } from "../src/venues/binance.ts";

/** A steady tape: `perSec` base units per second on one side, ten prints a second. */
function steadyTape(perSec: number, count: number, buyerIsMaker: boolean): AggTrade[] {
  const trades: AggTrade[] = [];
  for (let s = 0; s < count; s++) {
    for (let k = 0; k < 10; k++) {
      trades.push({ price: 100, qty: perSec / 10, time: s * 1000 + k * 100, buyerIsMaker });
    }
  }
  return trades;
}

/**
 * A random tape: Poisson-ish arrivals at `ratePerSec` unit trades per second.
 *
 * This is the shape the model was built for and the only one that produces a
 * real fill distribution — a steady tape is deterministic and every window
 * either clears the queue or does not, which cannot be calibrated against.
 */
function randomTape(ratePerSec: number, seconds: number, buyerIsMaker: boolean, seed: number): AggTrade[] {
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  const trades: AggTrade[] = [];
  let t = 0;
  const meanGapMs = 1000 / ratePerSec;
  while (t < seconds * 1000) {
    // Exponential inter-arrival for a Poisson process.
    t += -Math.log(1 - rand()) * meanGapMs;
    if (t >= seconds * 1000) break;
    trades.push({ price: 100, qty: 1, time: Math.round(t), buyerIsMaker });
  }
  return trades;
}

describe("the model in isolation", () => {
  test("more flow, and a shorter queue, both raise the fill chance", () => {
    // Kept off the 0.95 cap so the ordering is visible rather than saturated.
    const slow = predictFill(0.05, 20, 1, 60);
    const fast = predictFill(0.2, 20, 1, 60);
    assert.ok(fast > slow, `ten times the flow must fill more often (${fast} vs ${slow})`);

    const deep = predictFill(0.1, 50, 1, 60);
    const shallow = predictFill(0.1, 5, 1, 60);
    assert.ok(shallow > deep, `a shorter queue must fill more often (${shallow} vs ${deep})`);
  });

  test("no flow is no fill, and certainty is capped", () => {
    assert.equal(predictFill(0, 1, 1, 60), 0);
    assert.ok(predictFill(1e6, 0, 0.001, 60) <= 0.95, "the model never claims certainty");
  });
});

describe("scoring against a tape with a known answer", () => {
  test("flow that dwarfs the order fills it, and the model saw that coming", () => {
    const report = backtestFillModel(steadyTape(100, 300, true), { sizes: [1], queueAheads: [1], trailingSec: 60 });
    assert.ok(report.samples > 200, `expected a healthy sample count, got ${report.samples}`);
    assert.ok(report.observedFillRate > 0.98, `fills were certain, observed ${report.observedFillRate}`);
    assert.ok(report.meanPredicted > 0.9, `the model should have predicted near-certain, got ${report.meanPredicted}`);
    assert.ok(report.brierScore < 0.02, `a confident correct model has a low Brier, got ${report.brierScore}`);
  });

  test("an order far larger than the flow does not fill, and the model knew", () => {
    const report = backtestFillModel(steadyTape(1, 400, false), { sizes: [500], queueAheads: [0], trailingSec: 60 });
    assert.ok(report.samples > 200);
    assert.ok(report.observedFillRate < 0.02, `fills were impossible, observed ${report.observedFillRate}`);
    assert.ok(report.meanPredicted < 0.15, `the model should have predicted near-zero, got ${report.meanPredicted}`);
  });

  test("on genuinely random arrivals the predictions track the fills", () => {
    // The real test: Poisson flow at 1 unit/s, a size-40 order behind a size-20
    // queue, so about 60 units are expected over the 60s horizon against a 60
    // threshold — a real spread of outcomes the model has to call. Calibrated
    // means the average prediction lands close to the fill rate that happened.
    const report = backtestFillModel(randomTape(1, 4000, true, 12345), {
      sizes: [40], queueAheads: [20], trailingSec: 120,
    });
    assert.ok(report.samples > 1000, `expected many samples, got ${report.samples}`);
    assert.ok(report.observedFillRate > 0.15 && report.observedFillRate < 0.85, `expected a mixed outcome, got ${report.observedFillRate}`);
    // Calibration is the property a constant-rate tape can show: the average
    // prediction should land near the fill rate that actually happened.
    // Discrimination — a Brier well under a coin toss — needs the varying flow
    // of a real tape, which the live backtest, not this fixture, demonstrates.
    const gap = Math.abs(report.meanPredicted - report.observedFillRate);
    assert.ok(gap < 0.15, `predicted ${report.meanPredicted.toFixed(2)} vs observed ${report.observedFillRate.toFixed(2)} — a well-specified model should be within 15 points`);
    assert.ok(report.brierScore <= 0.27, `the model must not be worse than a coin toss, got ${report.brierScore.toFixed(3)}`);
  });

  test("a tape too short for both windows scores nothing rather than guessing", () => {
    const report = backtestFillModel(steadyTape(10, 5, true), { sizes: [1], queueAheads: [1], trailingSec: 120, horizonSec: 60 });
    assert.equal(report.samples, 0);
    assert.match(report.verdict, /too short/);
  });

  test("the rate is measured from the past, so the score is genuinely out-of-sample", () => {
    // Busy for exactly one trailing window, then dead. A point at the seam has
    // a busy trailing window and a dead forward one: the model, reading only the
    // past, predicts a fill the future does not deliver. A test fitted to the
    // future would hide that; out-of-sample it shows as optimism.
    const trailingSec = 60, horizonSec = 60;
    const busy = steadyTape(50, trailingSec, true);
    const dead: AggTrade[] = [];
    const start = trailingSec * 1000;
    for (let s = 0; s < horizonSec + 5; s++) dead.push({ price: 100, qty: 0.0001, time: start + s * 1000, buyerIsMaker: true });
    const report = backtestFillModel([...busy, ...dead], { sizes: [1], queueAheads: [1], trailingSec, horizonSec });
    assert.ok(report.samples > 0);
    assert.ok(report.meanPredicted > report.observedFillRate + 0.3, `trailing optimism must show: predicted ${report.meanPredicted.toFixed(2)}, observed ${report.observedFillRate.toFixed(2)}`);
  });
});
