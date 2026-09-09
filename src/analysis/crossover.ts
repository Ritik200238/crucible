/**
 * Where the cheaper venue changes hands.
 *
 * The whole argument for routing per order is that no venue is cheapest at
 * every size: the exchange charges a commission that does not care how large
 * the order is, and the pool charges an impact that cares about nothing else.
 * Somewhere between a small order and a large one they cross.
 *
 * A quote answers "which venue for this size". This answers the question behind
 * it — "up to what size should I be going on-chain at all?" — by finding the
 * size where the answer flips. That is a number an agent can act on once rather
 * than re-deriving on every order, and a number nobody can look up: it moves
 * with the book, the pool, the gas price and the account's own fee tier.
 *
 * Found by bisection on the real cost curves. Each probe is a real quote at a
 * real size, so this is a measurement of the live market, not a formula.
 */

import type { CostEstimate, Side, Snapshot } from "../types.ts";

export interface CrossoverProbe {
  usd: number;
  cheapest: string | null;
  onchainBps: number | null;
  binanceBps: number | null;
  edgeBps: number | null;
}

export interface CrossoverResult {
  symbol: string;
  side: Side;
  /** Which venue wins at the smallest size probed. */
  cheapestWhenSmall: string | null;
  /** Which venue wins at the largest size probed. */
  cheapestWhenLarge: string | null;
  /**
   * Size in the quote asset where the cheaper venue changes, or null when one
   * venue wins across the whole range probed.
   */
  crossoverUsd: number | null;
  /** How tightly the crossover was pinned down, as a fraction of its own size. */
  precision: number;
  probes: CrossoverProbe[];
  /** What the numbers support, in plain words. */
  verdict: string;
}

/** A quoter: prices every route for one size. Injected so this is testable. */
export type Quoter = (usd: number) => Promise<{ routes: CostEstimate[]; mid: number }>;

const label = (r: CostEstimate) =>
  r.venue === "ONCHAIN" ? "on-chain" : r.style === "MAKER" ? "Binance spot maker" : "Binance spot taker";

function best(routes: CostEstimate[]): CostEstimate | null {
  const usable = routes.filter((r) => !r.unavailable).sort((a, b) => a.totalBps - b.totalBps);
  return usable[0] ?? null;
}

function probeOf(usd: number, routes: CostEstimate[]): CrossoverProbe {
  const onchain = routes.find((r) => r.venue === "ONCHAIN" && !r.unavailable) ?? null;
  const binance = routes
    .filter((r) => r.venue === "BINANCE_SPOT" && !r.unavailable)
    .sort((a, b) => a.totalBps - b.totalBps)[0] ?? null;

  // A winner only means something when both venues answered. One side going
  // unpriceable at a size — a book too thin to fill it, a pool with no depth —
  // leaves the other standing alone, and calling that "cheaper" would turn a
  // missing quote into a comparison nobody made.
  const comparable = onchain !== null && binance !== null;
  const winner = comparable ? best([onchain!, binance!]) : null;

  return {
    usd,
    cheapest: winner ? label(winner) : null,
    onchainBps: onchain ? onchain.totalBps : null,
    binanceBps: binance ? binance.totalBps : null,
    edgeBps: comparable ? binance!.totalBps - onchain!.totalBps : null,
  };
}

/** True when both ends priced and disagree about the winner. */
const flips = (a: CrossoverProbe, b: CrossoverProbe) =>
  a.cheapest !== null && b.cheapest !== null && a.cheapest !== b.cheapest;

export interface CrossoverOptions {
  symbol: string;
  side: Side;
  /** Smallest order to consider, in the quote asset. */
  minUsd?: number;
  /** Largest order to consider. */
  maxUsd?: number;
  /** Bisection steps. Each one is a live quote, so this is a latency budget. */
  steps?: number;
}

/**
 * Find the size where the cheaper venue changes.
 *
 * Prices the two ends first. If the same venue wins at both, there is no
 * crossover inside the range and that is reported rather than a number
 * invented by bisecting a curve that never crosses. Otherwise the interval is
 * halved until the answer is pinned to a few per cent of its own size.
 */
export async function findCrossover(quote: Quoter, opts: CrossoverOptions): Promise<CrossoverResult> {
  const minUsd = opts.minUsd ?? 100;
  const maxUsd = opts.maxUsd ?? 500_000;
  const steps = opts.steps ?? 9;
  const probes: CrossoverProbe[] = [];

  const at = async (usd: number): Promise<CrossoverProbe> => {
    const { routes } = await quote(usd);
    const probe = probeOf(usd, routes);
    probes.push(probe);
    return probe;
  };

  const low = await at(minUsd);

  // The top of the range is a guess, and a guess can be past what either venue
  // will price: a book too thin to fill it, a pool with no depth at that size.
  // Rather than reporting a range the market would not answer, walk the top
  // down until both venues quote, and say afterwards which range was used.
  let high = await at(maxUsd);
  let ceiling = maxUsd;
  for (let i = 0; i < 4 && high.cheapest === null && ceiling / 2 > minUsd * 2; i++) {
    ceiling = Math.round(ceiling / 2);
    high = await at(ceiling);
  }

  const base = {
    symbol: opts.symbol,
    side: opts.side,
    cheapestWhenSmall: low.cheapest,
    cheapestWhenLarge: high.cheapest,
    probes,
  };

  if (low.cheapest === null || high.cheapest === null) {
    const end = low.cheapest === null ? low : high;
    const missing = end.binanceBps === null ? "Binance" : "the pool";
    const both = low.cheapest === null && high.cheapest === null;
    return {
      ...base, crossoverUsd: null, precision: 0,
      verdict:
        (both
          ? `Neither end of the range could be priced on both venues, so there is nothing to compare. `
          : `At ${money(end.usd)}, ${missing} could not price this order, so there is nothing to compare at ` +
            `that end and no crossover can be located. `) +
        `A quote that only one venue answered is not a venue winning; try a narrower range with --max.`,
    };
  }

  if (!flips(low, high)) {
    return {
      ...base, crossoverUsd: null, precision: 0,
      verdict:
        `${low.cheapest} is cheaper at every size from ${money(minUsd)} to ${money(ceiling)}, so there is no ` +
        `crossover in that range. On this pair, right now, the venue does not change with size.` +
        (ceiling < maxUsd
          ? ` The top was brought down from ${money(maxUsd)} because nothing would price an order that large.`
          : ""),
    };
  }

  // Both ends priced and they disagree, so a crossing exists between them.
  let lo = minUsd;
  let hi = ceiling;
  for (let i = 0; i < steps; i++) {
    const mid = Math.round(Math.sqrt(lo * hi)); // geometric: sizes span orders of magnitude
    if (mid <= lo || mid >= hi) break;
    const probe = await at(mid);
    if (probe.cheapest === null) break;
    if (probe.cheapest === low.cheapest) lo = mid;
    else hi = mid;
  }

  const crossoverUsd = Math.round((lo + hi) / 2);
  const precision = (hi - lo) / crossoverUsd;

  return {
    ...base,
    crossoverUsd,
    precision,
    verdict:
      `${low.cheapest} is cheaper up to about ${money(crossoverUsd)}, and ${high.cheapest} above it. ` +
      `Pinned between ${money(lo)} and ${money(hi)} by ${probes.length} live quotes. This moves with the ` +
      `book, the pool, the gas price and your own fee tier, so it is a reading, not a constant.` +
      (ceiling < maxUsd
        ? ` The range stops at ${money(ceiling)}: nothing would price an order as large as ${money(maxUsd)}.`
        : ""),
  };
}

function money(n: number): string {
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** Build a quoter that prices against a freshly taken snapshot at each size. */
export function liveQuoter(
  takeSnapshot: (opts: { symbol: string; side: Side; baseQty: number }) => Promise<Snapshot>,
  priceAllRoutes: (input: { snapshot: Snapshot; side: Side; baseQty: number }) => CostEstimate[],
  symbol: string,
  side: Side,
  midHint: number,
): Quoter {
  return async (usd: number) => {
    const baseQty = usd / midHint;
    const snapshot = await takeSnapshot({ symbol, side, baseQty });
    return { routes: priceAllRoutes({ snapshot, side, baseQty }), mid: snapshot.mid };
  };
}
