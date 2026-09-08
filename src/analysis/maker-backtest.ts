/**
 * Does the maker fill model actually predict maker fills?
 *
 * The maker cost is weighted by a fill probability, and that probability is the
 * one genuinely modelled thing in this product — a Poisson arrival of measured
 * order flow. Nowhere else is a maker order's chance of filling priced at all,
 * so nowhere else is it checked. This checks it, out-of-sample, against the
 * real tape.
 *
 * The method is deliberately not circular. At each point in a recorded tape the
 * flow rate is measured from the *trailing* window — the past only — and fed
 * through the exact model the router uses to predict a resting order's chance
 * of filling. Then the *forward* window is read to see whether enough same-side
 * volume actually arrived to clear the queue. Past flow predicting future
 * arrivals is a real empirical claim: if flow were bursty and unpredictable the
 * trailing rate would predict nothing, and this would show it.
 *
 * What it cannot see: a real resting order's exact queue position, which the
 * live book supplies and a historical tape does not. So the queue ahead is a
 * parameter, swept across plausible values, and the result is honest about
 * being conditioned on it.
 */

import type { AggTrade } from "../venues/binance.ts";
import { FILL_HORIZON_SEC } from "../cost/model.ts";

/** The router's fill model, isolated so the backtest scores the real thing. */
export function predictFill(ratePerSec: number, queueAhead: number, sizeBase: number, horizonSec: number): number {
  if (!(ratePerSec > 0)) return 0;
  const needed = queueAhead + sizeBase;
  if (!(needed > 0)) return 0;
  const expected = (ratePerSec * horizonSec) / needed;
  return Math.min(0.95, 1 - Math.exp(-expected));
}

export interface BacktestOptions {
  /** Order sizes to test, in the base asset. */
  sizes: number[];
  /** Queue-ahead assumptions, in the base asset. A live book would supply one. */
  queueAheads: number[];
  /** Forward window a resting order waits, seconds. Defaults to the router's. */
  horizonSec?: number;
  /** Trailing window the rate is measured over, seconds. */
  trailingSec?: number;
}

export interface CalibrationBucket {
  /** Lower edge of the predicted-probability band, e.g. 0.4 for the 40–50% bucket. */
  from: number;
  samples: number;
  meanPredicted: number;
  observedFillRate: number;
}

export interface BacktestReport {
  /** (prediction, outcome) pairs scored. */
  samples: number;
  /** Mean squared error of the probability against the 0/1 outcome. Lower is better; 0.25 is a coin flip. */
  brierScore: number;
  /** Predicted fill rate across all samples, against observed. Close means calibrated overall. */
  meanPredicted: number;
  observedFillRate: number;
  buckets: CalibrationBucket[];
  /** What the numbers support, in plain words. */
  verdict: string;
}

interface Point {
  predicted: number;
  filled: boolean;
}

/**
 * Score the fill model against a recorded tape.
 *
 * One side only would test half the book; both sides are scored and pooled. A
 * resting buy fills from sellers crossing into the bid (`buyerIsMaker`); a
 * resting sell from buyers lifting the ask. The rate for each is measured from
 * the trailing window and the arrivals from the forward window, on that side.
 */
export function backtestFillModel(trades: AggTrade[], opts: BacktestOptions): BacktestReport {
  const horizonSec = opts.horizonSec ?? FILL_HORIZON_SEC;
  const trailingMs = (opts.trailingSec ?? 120) * 1000;
  const horizonMs = horizonSec * 1000;

  const sorted = [...trades].sort((a, b) => a.time - b.time);
  const points: Point[] = [];

  // Both sides. `true` = fills for a resting buy (sellers hitting the bid).
  for (const restingBuy of [true, false]) {
    for (let i = 0; i < sorted.length; i++) {
      const t = sorted[i]!.time;

      // The trailing window must be full, or the rate is measured over less time
      // than it claims and reads too high.
      if (t - sorted[0]!.time < trailingMs) continue;
      // The forward window must fit inside the tape, or a fill that would have
      // happened just past the end is scored as a miss.
      if (sorted[sorted.length - 1]!.time - t < horizonMs) continue;

      let trailingVol = 0;
      for (let j = i - 1; j >= 0 && sorted[j]!.time >= t - trailingMs; j--) {
        if (sorted[j]!.buyerIsMaker === restingBuy) trailingVol += sorted[j]!.qty;
      }
      const ratePerSec = trailingVol / (trailingMs / 1000);
      if (!(ratePerSec > 0)) continue;

      let forwardVol = 0;
      for (let j = i + 1; j < sorted.length && sorted[j]!.time <= t + horizonMs; j++) {
        if (sorted[j]!.buyerIsMaker === restingBuy) forwardVol += sorted[j]!.qty;
      }

      for (const size of opts.sizes) {
        for (const queue of opts.queueAheads) {
          const predicted = predictFill(ratePerSec, queue, size, horizonSec);
          const filled = forwardVol >= queue + size;
          points.push({ predicted, filled });
        }
      }
    }
  }

  return summarise(points);
}

function summarise(points: Point[]): BacktestReport {
  if (points.length === 0) {
    return {
      samples: 0, brierScore: NaN, meanPredicted: NaN, observedFillRate: NaN, buckets: [],
      verdict: "No samples: the tape was too short for a full trailing and forward window.",
    };
  }

  const n = points.length;
  const brier = points.reduce((a, p) => a + (p.predicted - (p.filled ? 1 : 0)) ** 2, 0) / n;
  const meanPredicted = points.reduce((a, p) => a + p.predicted, 0) / n;
  const observed = points.filter((p) => p.filled).length / n;

  const buckets: CalibrationBucket[] = [];
  for (let b = 0; b < 10; b++) {
    const from = b / 10;
    const inBucket = points.filter((p) => p.predicted >= from && p.predicted < from + 0.1 + (b === 9 ? 1e-9 : 0));
    if (inBucket.length === 0) continue;
    buckets.push({
      from,
      samples: inBucket.length,
      meanPredicted: inBucket.reduce((a, p) => a + p.predicted, 0) / inBucket.length,
      observedFillRate: inBucket.filter((p) => p.filled).length / inBucket.length,
    });
  }

  return { samples: n, brierScore: brier, meanPredicted, observedFillRate: observed, buckets, verdict: describe(n, brier, meanPredicted, observed) };
}

function describe(n: number, brier: number, predicted: number, observed: number): string {
  const gap = Math.abs(predicted - observed);
  const bias = predicted > observed ? "optimistic" : "conservative";
  if (n < 200) {
    return `${n} samples — too few to say much. The tape needs to be longer to test the model properly.`;
  }
  const quality =
    brier < 0.18
      ? "The model tracks real fills well"
      : brier < 0.24
        ? "The model is roughly right but loose"
        : "The model predicts poorly on this tape";
  return (
    `${n} out-of-sample predictions. Brier score ${brier.toFixed(3)} (0.25 is a coin toss). ` +
    `Across all of them the model expected ${(predicted * 100).toFixed(0)}% to fill and ${(observed * 100).toFixed(0)}% did, ` +
    `a ${(gap * 100).toFixed(0)}-point ${bias} bias. ${quality}.`
  );
}
