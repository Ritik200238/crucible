/**
 * How wrong the cost model actually is.
 *
 * Every execution records what was predicted and what it cost. This reads those
 * back and reports the difference — not as a summary of good news, but as the
 * measurement that says whether anything else in this product can be believed.
 *
 * It is deliberately built to have nothing to say until real orders have been
 * placed. A calibration curve fitted to zero executions would be a confident
 * line drawn through no data, which is worse than an empty report because it
 * looks like evidence.
 */

import type { LedgerRecord } from "../ledger/chain.ts";
import type { Venue } from "../types.ts";

/**
 * Both kinds of record that carry a prediction and an outcome. A reconciled
 * fill arrived late, but it is still a real fill against a real prediction,
 * and the model is graded on it like any other. Only a reconciliation that
 * found something traded qualifies; one that found nothing has no cost.
 */
const COMPLETED = "execution.completed";
const RECONCILED = "execution.reconciled";

interface CompletedPayload {
  venue?: Venue;
  outcome?: string;
  predictedBps?: number;
  realisedBps?: number | null;
  errorBps?: number | null;
  savingUsd?: number | null;
}

/** One execution's prediction against its outcome. */
export interface CalibrationPoint {
  at: string;
  venue: Venue | "UNKNOWN";
  predictedBps: number;
  realisedBps: number;
  errorBps: number;
}

export interface CalibrationReport {
  /** Executions with a complete prediction and outcome. */
  samples: number;
  /** Executions that ran but whose realised cost could not be completed. */
  incomparable: number;
  /**
   * Mean error, signed. Positive means the model predicted too little — trades
   * cost more than promised, which is the direction that matters.
   */
  meanErrorBps: number | null;
  medianErrorBps: number | null;
  /** Typical size of a miss, ignoring direction. */
  meanAbsErrorBps: number | null;
  /** The worst miss seen, so a good average cannot hide a bad tail. */
  worstErrorBps: number | null;
  byVenue: { venue: string; samples: number; meanErrorBps: number }[];
  points: CalibrationPoint[];
  /** What the numbers can and cannot support, in plain words. */
  verdict: string;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Read the ledger and say how well the model has been predicting.
 *
 * The verdict is graded by sample count before anything else, because the size
 * of an error matters far less than whether there is enough of it to mean
 * anything. Three executions cannot establish a bias no matter how consistent
 * they look.
 */
export function calibration(records: LedgerRecord[]): CalibrationReport {
  const points: CalibrationPoint[] = [];
  let incomparable = 0;

  for (const record of records) {
    if (record.kind !== COMPLETED && record.kind !== RECONCILED) continue;
    const p = (record.payload ?? {}) as CompletedPayload;
    if (record.kind === RECONCILED && p.outcome !== "filled" && p.outcome !== "partial") continue;

    if (
      typeof p.predictedBps !== "number" ||
      typeof p.realisedBps !== "number" ||
      typeof p.errorBps !== "number"
    ) {
      // The execution happened; its cost could not be completed, usually
      // because commission was charged in an asset the fill could not price.
      incomparable++;
      continue;
    }
    points.push({
      at: record.timestamp,
      venue: p.venue ?? "UNKNOWN",
      predictedBps: p.predictedBps,
      realisedBps: p.realisedBps,
      errorBps: p.errorBps,
    });
  }

  if (points.length === 0) {
    return {
      samples: 0,
      incomparable,
      meanErrorBps: null,
      medianErrorBps: null,
      meanAbsErrorBps: null,
      worstErrorBps: null,
      byVenue: [],
      points: [],
      verdict:
        incomparable > 0
          ? `${incomparable} execution(s) ran but none produced a comparable cost, so the model has ` +
            `not been graded. Nothing here should be read as evidence that it predicts well.`
          : `No orders have been executed, so the cost model has never been checked against a real ` +
            `fill. Every figure this product reports is a prediction that has not yet been graded.`,
    };
  }

  const errors = points.map((p) => p.errorBps);
  const abs = errors.map(Math.abs);

  const venues = new Map<string, number[]>();
  for (const p of points) {
    venues.set(p.venue, [...(venues.get(p.venue) ?? []), p.errorBps]);
  }

  const meanError = mean(errors);
  const worst = abs.reduce((a, b) => Math.max(a, b), 0);
  const signedWorst = errors.find((e) => Math.abs(e) === worst) ?? worst;

  return {
    samples: points.length,
    incomparable,
    meanErrorBps: meanError,
    medianErrorBps: median(errors),
    meanAbsErrorBps: mean(abs),
    worstErrorBps: signedWorst,
    byVenue: [...venues.entries()]
      .map(([venue, errs]) => ({
        venue,
        samples: errs.length,
        meanErrorBps: mean(errs),
      }))
      .sort((a, b) => b.samples - a.samples),
    points,
    verdict: describe(points.length, meanError, mean(abs)),
  };
}

function describe(samples: number, meanError: number, meanAbs: number): string {
  const direction = meanError > 0 ? "more" : "less";
  const size = Math.abs(meanError).toFixed(2);

  if (samples < 5) {
    return (
      `${samples} execution(s). Far too few to establish anything about the model's accuracy — ` +
      `the figures above describe what happened, not what tends to happen.`
    );
  }
  if (samples < 30) {
    return (
      `${samples} executions. Enough to notice a large bias but not to rule out a small one. ` +
      `Trades have cost ${size} bps ${direction} than predicted on average, with a typical miss of ` +
      `${meanAbs.toFixed(2)} bps.`
    );
  }
  return (
    `${samples} executions. Trades cost ${size} bps ${direction} than predicted on average, with a ` +
    `typical miss of ${meanAbs.toFixed(2)} bps. A consistent bias in one direction is the model ` +
    `being wrong in a fixable way; scatter around zero is the market being unpredictable, which it is.`
  );
}
