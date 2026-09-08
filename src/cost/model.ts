/**
 * What a trade actually costs, on each route.
 *
 * Everything is quoted in basis points of the Binance mid at snapshot time, so
 * three different venues with three different fee structures land on one
 * comparable axis. A basis point is 0.01%.
 *
 * The rule the whole model follows: never net a cost against a benefit that has
 * not happened. Posting a maker order *might* earn the spread, so the earning is
 * weighted by the chance of being filled, and the shortfall of missing is
 * charged. Modelling it as a certain gain is how execution tools end up
 * recommending an order that never fills.
 */

import { walkBook, queueAhead } from "../snapshot.ts";
import { feeTierBps, walletServiceFeeRate } from "../venues/onchain.ts";
import type {
  CostComponent,
  CostEstimate,
  Side,
  Snapshot,
  Style,
  Venue,
} from "../types.ts";

const BPS = 10_000;

/** Cost of a route, given the size, expressed against mid. */
export interface CostInput {
  snapshot: Snapshot;
  side: Side;
  baseQty: number;
}

function sum(components: CostComponent[]): number {
  return components.reduce((a, c) => a + c.bps, 0);
}

function finish(
  venue: Venue,
  style: Style,
  components: CostComponent[],
  input: CostInput,
): CostEstimate {
  const totalBps = sum(components);
  const notionalUsd = input.baseQty * input.snapshot.mid;
  // A cost is what you pay above mid to buy, or below mid to receive when
  // selling. The sign of the price adjustment therefore flips with the side.
  const direction = input.side === "BUY" ? 1 : -1;
  return {
    venue,
    style,
    components,
    totalBps,
    totalUsd: (totalBps / BPS) * notionalUsd,
    effectivePrice: input.snapshot.mid * (1 + (direction * totalBps) / BPS),
    hasEstimates: components.some((c) => c.estimated),
  };
}

function unavailable(venue: Venue, style: Style, reason: string): CostEstimate {
  return {
    venue,
    style,
    components: [],
    totalBps: Infinity,
    totalUsd: Infinity,
    effectivePrice: 0,
    unavailable: reason,
    hasEstimates: false,
  };
}

/**
 * Binance, crossing the spread.
 *
 * Three costs, all real and all charged: the taker commission, half the spread
 * to reach the touch, and the impact of eating however many levels the size
 * needs. The last two come from walking the live book rather than from an
 * assumed constant, because they are the two that change with size.
 */
export function costBinanceTaker(input: CostInput): CostEstimate {
  const { snapshot: s, side, baseQty } = input;
  const walk = walkBook(s.book, side, baseQty);

  if (walk.exhausted) {
    return unavailable(
      "BINANCE_SPOT",
      "TAKER",
      `The visible book holds only ${walk.filled.toFixed(6)} of the ${baseQty.toFixed(6)} needed. ` +
        `Filling this size would reach past the top 100 levels, and the cost cannot be measured honestly.`,
    );
  }

  const touch = side === "BUY" ? s.bestAsk : s.bestBid;
  const direction = side === "BUY" ? 1 : -1;

  const halfSpreadBps = ((touch - s.mid) / s.mid) * BPS * direction;
  const walkBps = ((walk.avgPrice - s.mid) / s.mid) * BPS * direction;
  const impactBps = walkBps - halfSpreadBps;

  const components: CostComponent[] = [
    {
      name: "taker fee",
      bps: s.commission.taker * BPS,
      detail:
        s.commission.source === "account"
          ? `Your account's taker rate, ${(s.commission.taker * 100).toFixed(4)}%.`
          : `Public VIP 0 taker rate, ${(s.commission.taker * 100).toFixed(4)}%. Your real rate may be lower.`,
      estimated: s.commission.source !== "account",
    },
    {
      name: "half spread",
      bps: halfSpreadBps,
      detail: `Reaching the touch at ${touch.toFixed(s.filters.quoteAssetPrecision)} from a mid of ${s.mid.toFixed(s.filters.quoteAssetPrecision)}.`,
    },
    {
      name: "book impact",
      bps: impactBps,
      detail:
        walk.levelsUsed <= 1
          ? "The whole order fits on the touch, so it moves the book none."
          : `Eating ${walk.levelsUsed} levels to fill ${baseQty.toFixed(6)}.`,
    },
  ];

  return finish("BINANCE_SPOT", "TAKER", components, input);
}

/** How long a resting order is given to fill before the estimate gives up on it. */
export const FILL_HORIZON_SEC = 60;

/**
 * Probability a resting order at the touch gets filled.
 *
 * Built on measured flow rather than a guess. An order posted at the bid fills
 * only once sellers have crossed enough volume to clear the queue already there
 * plus the order itself, so the quantity that matters is `queue + size` and the
 * rate that matters is the one arriving on that side. Treating arrivals as
 * Poisson gives the exponential below.
 *
 * The direction is the part that is easy to get backwards, and getting it
 * backwards is what makes a model recommend posting a large order because it is
 * large. A bigger order needs more volume to clear it, so its chance falls.
 *
 * Returns 0 when nothing is trading on that side. Nothing arriving means nothing
 * fills, and there is no honest way to round that up.
 */
export function fillProbability(snapshot: Snapshot, side: Side, baseQty: number): number {
  const rate = side === "BUY" ? snapshot.flow.hitsBidPerSec : snapshot.flow.liftsAskPerSec;
  if (!(rate > 0)) return 0;

  const ahead = queueAhead(snapshot.book, side);
  const needed = ahead + baseQty;
  if (!(needed > 0)) return 0;

  const expectedArrivals = (rate * FILL_HORIZON_SEC) / needed;
  const p = 1 - Math.exp(-expectedArrivals);

  // Capped short of certainty. A queue model cannot see order cancellations, a
  // price that walks away, or anyone jumping ahead by a tick, and each of those
  // only ever makes filling less likely than this says.
  return Math.min(0.95, p);
}

/**
 * Binance, posting at the touch.
 *
 * Worth stating plainly, because it is the counterintuitive part: at VIP 0 the
 * maker and taker rates are identical. Posting therefore saves only the half
 * spread, which on a liquid pair is a fraction of a basis point, while adding
 * the risk of not filling at all. The model prices that honestly and will
 * frequently conclude that posting is not worth it.
 */
export function costBinanceMaker(input: CostInput): CostEstimate {
  const { snapshot: s, side, baseQty } = input;
  const touch = side === "BUY" ? s.bestBid : s.bestAsk;
  const direction = side === "BUY" ? 1 : -1;

  // Posting at the touch is on the passive side of mid, so this is a credit.
  const spreadCreditBps = ((touch - s.mid) / s.mid) * BPS * direction;
  const p = fillProbability(s, side, baseQty);

  const takerFallback = costBinanceTaker(input);
  if (takerFallback.unavailable) {
    return unavailable(
      "BINANCE_SPOT",
      "MAKER",
      `Cannot price the fallback for an unfilled post: ${takerFallback.unavailable}`,
    );
  }

  const components: CostComponent[] = [
    {
      name: "maker fee",
      bps: s.commission.maker * BPS * p,
      detail: `${(s.commission.maker * 100).toFixed(4)}% maker rate, weighted by a ${(p * 100).toFixed(0)}% chance of filling.`,
      estimated: true,
    },
    {
      name: "spread earned",
      bps: spreadCreditBps * p,
      detail: `Resting at ${touch.toFixed(s.filters.quoteAssetPrecision)} instead of crossing, weighted by fill chance.`,
      estimated: true,
    },
    {
      name: "unfilled fallback",
      bps: takerFallback.totalBps * (1 - p),
      detail: `A ${((1 - p) * 100).toFixed(0)}% chance of missing and having to cross later at ${takerFallback.totalBps.toFixed(2)} bps.`,
      estimated: true,
    },
  ];

  return finish("BINANCE_SPOT", "MAKER", components, input);
}

/**
 * On-chain, through the pool.
 *
 * The quoter returns what the swap would actually pay out, which already
 * contains both the pool fee and the price impact. Splitting them back apart is
 * presentation only — the total is the quoter's, not ours, so the number cannot
 * drift from what the pool would really do.
 */
export function costOnchain(input: CostInput): CostEstimate {
  const { snapshot: s, side, baseQty } = input;

  if (!s.onchain) {
    return unavailable("ONCHAIN", "TAKER", s.onchainUnavailable ?? "No on-chain quote was taken.");
  }
  const best = s.onchain.best;
  if (!best) {
    return unavailable("ONCHAIN", "TAKER", "No pool answered for this pair at this size.");
  }

  const notionalUsd = baseQty * s.mid;

  // For a BUY the pool takes quote and returns base, so the effective price is
  // input over output. For a SELL it is the reverse.
  const effective = side === "BUY" ? s.onchain.amountIn / best.amountOut : best.amountOut / baseQty;
  const direction = side === "BUY" ? 1 : -1;
  const allInBps = ((effective - s.mid) / s.mid) * BPS * direction;

  const poolFeeBps = feeTierBps(best.feeTier);
  const serviceRate = walletServiceFeeRate(s.filters.baseAsset, s.filters.quoteAsset);
  const gasBps = (s.onchain.gasCostUsd / notionalUsd) * BPS;

  // Split the remainder into the two things it is actually made of. Without the
  // reference price they cannot be told apart, so in that case they are reported
  // as one figure rather than guessed at.
  const reference = s.onchain.referencePrice;
  const components: CostComponent[] = [
    {
      name: "pool fee",
      bps: poolFeeBps,
      detail: `The ${(best.feeTier / 10_000).toFixed(2)}% tier, chosen because it paid out most at this size.`,
    },
  ];

  if (reference !== null && reference > 0) {
    // The reference is the pool's price at negligible size, in the same
    // orientation as `effective`.
    const poolMid = side === "BUY" ? 1 / reference : reference;

    // Both prices already have the pool fee inside them, so it cancels in their
    // difference — impact is the pure size effect. It must therefore NOT be
    // subtracted again here, and it has to come off the divergence instead, or
    // the fee gets counted twice and impact comes out negative.
    const impactBps = ((effective - poolMid) / s.mid) * BPS * direction;
    const divergenceBps = allInBps - poolFeeBps - impactBps;

    components.push(
      {
        name: "venue divergence",
        bps: divergenceBps,
        detail:
          divergenceBps < 0
            ? `The pool is trading ${Math.abs(divergenceBps).toFixed(2)} bps better than the Binance mid right now. This is the market, not a saving this product created.`
            : `The pool is trading ${divergenceBps.toFixed(2)} bps worse than the Binance mid right now.`,
      },
      {
        name: "price impact",
        bps: impactBps,
        detail: `How far this size pushes the pool past its own mid of ${poolMid.toFixed(s.filters.quoteAssetPrecision)}.`,
      },
    );
  } else {
    components.push({
      name: "impact and divergence",
      bps: allInBps - poolFeeBps,
      detail:
        "Reported together: the reference quote that separates pool movement from the venue gap did not return.",
      estimated: true,
    });
  }

  components.push(
    {
      name: "gas",
      bps: gasBps,
      detail: `$${s.onchain.gasCostUsd.toFixed(4)} at ${(s.onchain.gasPriceWei / 1e9).toFixed(3)} gwei, spread over $${notionalUsd.toFixed(2)}.`,
    },
    {
      name: "wallet service fee",
      bps: serviceRate * BPS,
      detail:
        serviceRate === 0
          ? `Free: ${s.filters.baseAsset} and ${s.filters.quoteAsset} are both major assets.`
          : `${(serviceRate * 100).toFixed(2)}% charged when either side is outside the major-asset group.`,
    },
  );

  return finish("ONCHAIN", "TAKER", components, input);
}

/** Every route, priced. Unavailable routes are kept, with their reason. */
export function priceAllRoutes(input: CostInput): CostEstimate[] {
  return [costBinanceTaker(input), costBinanceMaker(input), costOnchain(input)];
}
