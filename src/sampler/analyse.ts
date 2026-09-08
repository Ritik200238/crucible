/**
 * Turning samples into a finding.
 *
 * The claim this product makes is comparative and quantitative, so the analysis
 * has to be too. Everything here is computed from `data/samples.jsonl` and
 * nothing is carried in by hand, which is what lets the evidence document be
 * regenerated rather than reported.
 *
 * Medians are used throughout rather than means. A single sample taken while
 * one venue was mid-dislocation can move a mean by more than the effect being
 * measured; the median says what usually happens, which is the question.
 */

import type { Sample } from "./run.ts";

export const ONCHAIN_ROUTE = "ONCHAIN/TAKER";
export const BINANCE_TAKER_ROUTE = "BINANCE_SPOT/TAKER";
export const BINANCE_MAKER_ROUTE = "BINANCE_SPOT/MAKER";

export interface Bucket {
  symbol: string;
  notionalUsd: number;
  count: number;
  /** Share of samples where the on-chain route was cheapest. */
  onchainWinRate: number;
  /** Median of (best Binance route − on-chain), so positive means on-chain won. */
  medianEdgeBps: number;
  medianOnchainBps: number;
  medianBinanceBps: number;
  /** Median of each named on-chain cost component, for attribution. */
  medianOnchainParts: Record<string, number>;
}

export interface EvidenceReport {
  total: number;
  failures: number;
  from: string;
  to: string;
  spanHours: number;
  buckets: Bucket[];
  onchainWinRate: number;
  medianEdgeBps: number;
  /** Where the cheaper venue changes, if the samples show a crossover. */
  crossoverNote: string;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The edge of the on-chain route over the best Binance route, in bps.
 *
 * Positive means on-chain was cheaper. Returns null when either side could not
 * be priced — a sample that only saw one venue says nothing about which is
 * better, and averaging it in as a win for the venue that answered would be a
 * quiet bias toward whichever was up that day.
 */
export function edgeBps(sample: Sample): number | null {
  const onchain = sample.routes[ONCHAIN_ROUTE];
  const binance = [sample.routes[BINANCE_TAKER_ROUTE], sample.routes[BINANCE_MAKER_ROUTE]].filter(
    (v): v is number => typeof v === "number",
  );
  if (typeof onchain !== "number" || binance.length === 0) return null;
  return Math.min(...binance) - onchain;
}

function medianParts(samples: Sample[]): Record<string, number> {
  const byName = new Map<string, number[]>();
  for (const s of samples) {
    for (const [name, bps] of Object.entries(s.onchainParts ?? {})) {
      const list = byName.get(name) ?? [];
      list.push(bps);
      byName.set(name, list);
    }
  }
  return Object.fromEntries(
    [...byName.entries()].map(([name, values]) => [name, Number(median(values).toFixed(4))]),
  );
}

export function summarise(samples: Sample[], failures = 0): EvidenceReport {
  const usable = samples.filter((s) => edgeBps(s) !== null);

  const keyed = new Map<string, Sample[]>();
  for (const s of usable) {
    const key = `${s.symbol}|${s.notionalUsd}`;
    keyed.set(key, [...(keyed.get(key) ?? []), s]);
  }

  const buckets: Bucket[] = [...keyed.entries()]
    .map(([key, rows]) => {
      const [symbol, size] = key.split("|");
      const edges = rows.map((r) => edgeBps(r)!).filter(Number.isFinite);
      const onchainCosts = rows
        .map((r) => r.routes[ONCHAIN_ROUTE])
        .filter((v): v is number => typeof v === "number");
      const binanceCosts = rows
        .map((r) =>
          Math.min(
            ...[r.routes[BINANCE_TAKER_ROUTE], r.routes[BINANCE_MAKER_ROUTE]].filter(
              (v): v is number => typeof v === "number",
            ),
          ),
        )
        .filter(Number.isFinite);

      return {
        symbol: symbol!,
        notionalUsd: Number(size),
        count: rows.length,
        onchainWinRate: edges.filter((e) => e > 0).length / (edges.length || 1),
        medianEdgeBps: Number(median(edges).toFixed(4)),
        medianOnchainBps: Number(median(onchainCosts).toFixed(4)),
        medianBinanceBps: Number(median(binanceCosts).toFixed(4)),
        medianOnchainParts: medianParts(rows),
      };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.notionalUsd - b.notionalUsd);

  const allEdges = usable.map((s) => edgeBps(s)!).filter(Number.isFinite);
  const times = samples.map((s) => s.at).sort();

  return {
    total: usable.length,
    failures,
    from: times[0] ?? "",
    to: times[times.length - 1] ?? "",
    spanHours:
      times.length > 1
        ? (new Date(times[times.length - 1]!).getTime() - new Date(times[0]!).getTime()) / 3_600_000
        : 0,
    buckets,
    onchainWinRate: allEdges.filter((e) => e > 0).length / (allEdges.length || 1),
    medianEdgeBps: Number(median(allEdges).toFixed(4)),
    crossoverNote: describeCrossover(buckets),
  };
}

/**
 * Say where the cheaper venue changes, if it does.
 *
 * Reported per symbol because the crossover depends on pool depth, and the pools
 * differ. Stating a single figure across symbols would be an average of two
 * different markets and true of neither.
 */
export function describeCrossover(buckets: Bucket[]): string {
  const bySymbol = new Map<string, Bucket[]>();
  for (const b of buckets) bySymbol.set(b.symbol, [...(bySymbol.get(b.symbol) ?? []), b]);

  const notes: string[] = [];
  for (const [symbol, rows] of bySymbol) {
    const ordered = [...rows].sort((a, b) => a.notionalUsd - b.notionalUsd);
    const flip = ordered.findIndex((b) => b.medianEdgeBps <= 0);
    if (flip <= 0) {
      notes.push(
        flip === 0
          ? `${symbol}: Binance was cheaper at every size sampled.`
          : `${symbol}: on-chain was cheaper at every size sampled, up to $${ordered[ordered.length - 1]?.notionalUsd.toLocaleString("en-US")}.`,
      );
    } else {
      const last = ordered[flip - 1]!;
      const first = ordered[flip]!;
      notes.push(
        `${symbol}: on-chain is cheaper to about $${last.notionalUsd.toLocaleString("en-US")}, ` +
          `and Binance takes over by $${first.notionalUsd.toLocaleString("en-US")}.`,
      );
    }
  }
  return notes.join(" ");
}
