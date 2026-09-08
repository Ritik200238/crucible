/**
 * Market snapshot.
 *
 * One object, captured at one instant, holding everything a routing decision is
 * allowed to depend on. Nothing downstream reads a clock or a network: it all
 * reads this. That is what lets a decision be replayed from its hash and come
 * out identical, and what makes a receipt worth anything after the fact.
 *
 * The two venues are fetched concurrently on purpose. Sequential fetches would
 * compare a Binance price from one moment against a pool price from a second
 * later, and at the sizes this product routes that gap is larger than the edge
 * being measured.
 */

import { createHash } from "node:crypto";
import {
  fetchAggTrades,
  fetchBookTicker,
  fetchOrderBook,
  fetchSymbolFilters,
  tradeRates,
  VIP0,
} from "./venues/binance.ts";
import { quoteOnchain, OnchainError } from "./venues/onchain.ts";
import { fetchWalletQuote } from "./venues/wallet-quote.ts";
import type { CommissionRates, OrderBook, Side, Snapshot } from "./types.ts";

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

export interface SnapshotOptions {
  symbol: string;
  side: Side;
  /** Size in the base asset. Determines the on-chain quote, so it is required. */
  baseQty: number;
  /** Real account rates when a credential exists; the public schedule otherwise. */
  commission?: CommissionRates;
  /** Skip the on-chain leg. Used by the Binance-only sampler path. */
  skipOnchain?: boolean;
  /**
   * Also ask the wallet for its own executable quote.
   *
   * Costs a subprocess, so it is off by default. The routing path turns it on,
   * because that is where an order might actually be sent and where a second
   * opinion on the price is worth a second of latency. The sampler leaves it
   * off and prices from the pool alone.
   */
  includeWalletQuote?: boolean;
}

/**
 * Hash of every field a decision may read.
 *
 * `takenAt` is deliberately included: two snapshots of an unchanged market are
 * still different observations, and a receipt that could not distinguish them
 * would let a stale decision masquerade as a fresh one.
 */
export function hashSnapshot(s: Omit<Snapshot, "hash">): string {
  const h = createHash("sha256");
  h.update(
    JSON.stringify([
      s.symbol,
      s.takenAt,
      s.bestBid,
      s.bestAsk,
      s.book.lastUpdateId,
      s.book.bids.map((l) => [l.price, l.qty]),
      s.book.asks.map((l) => [l.price, l.qty]),
      s.filters.stepSize,
      s.filters.tickSize,
      s.filters.minNotional,
      s.commission.maker,
      s.commission.taker,
      s.commission.source,
      Number(s.flow.hitsBidPerSec.toFixed(6)),
      Number(s.flow.liftsAskPerSec.toFixed(6)),
      Number(s.flow.windowSec.toFixed(3)),
      s.onchain
        ? [
            s.onchain.amountIn,
            s.onchain.gasPriceWei,
            s.onchain.tiers.map((t) => [t.feeTier, t.amountOut, t.gasEstimate]),
            s.onchain.walletQuote
              ? [s.onchain.walletQuote.amountIn, s.onchain.walletQuote.amountOut]
              : null,
          ]
        : null,
    ]),
  );
  return h.digest("hex").slice(0, 16);
}

export async function takeSnapshot(opts: SnapshotOptions): Promise<Snapshot> {
  const symbol = opts.symbol.toUpperCase();
  if (!(opts.baseQty > 0)) {
    throw new SnapshotError("baseQty must be greater than zero to price either venue.");
  }

  const takenAt = Date.now();
  const [ticker, book, filters, trades] = await Promise.all([
    fetchBookTicker(symbol),
    fetchOrderBook(symbol, 100),
    fetchSymbolFilters(symbol),
    fetchAggTrades(symbol, 500),
  ]);
  const flow = tradeRates(trades);

  const bestBid = ticker.bidPrice;
  const bestAsk = ticker.askPrice;
  const mid = (bestBid + bestAsk) / 2;
  if (!(mid > 0)) throw new SnapshotError(`${symbol} has no usable mid price.`);

  const commission = opts.commission ?? VIP0;

  let onchain: Snapshot["onchain"] = null;
  let onchainUnavailable: string | undefined;

  if (!opts.skipOnchain) {
    try {
      onchain = await quoteOnchain({
        baseAsset: filters.baseAsset,
        quoteAsset: filters.quoteAsset,
        side: opts.side,
        baseQty: opts.baseQty,
        bnbPriceUsd: mid,
      });
    } catch (err) {
      // A missing on-chain quote is a normal outcome for an unlisted pair or a
      // dead RPC. The snapshot still stands with one venue, and the reason is
      // carried through to the report rather than silently becoming "no route".
      onchainUnavailable =
        err instanceof OnchainError ? err.message : `On-chain pricing failed: ${(err as Error).message}`;
    }

    if (onchain && opts.includeWalletQuote) {
      onchain.walletQuote = await fetchWalletQuote({
        baseAsset: filters.baseAsset,
        quoteAsset: filters.quoteAsset,
        side: opts.side,
        baseQty: opts.baseQty,
        midPrice: mid,
      });
    }
  }

  const partial: Omit<Snapshot, "hash"> = {
    symbol,
    takenAt,
    mid,
    bestBid,
    bestAsk,
    spreadBps: ((bestAsk - bestBid) / mid) * 10_000,
    book,
    filters,
    commission,
    flow,
    onchain,
    ...(onchainUnavailable ? { onchainUnavailable } : {}),
  };

  return { ...partial, hash: hashSnapshot(partial) };
}

/**
 * Walk the book for a given size and report the average fill price.
 *
 * A market order does not fill at the touch; it eats levels until it is full.
 * The difference between the touch and that average is the impact, and at the
 * sizes an agent trades it is frequently larger than the fee.
 *
 * Returns `filled` below the requested size when the visible book runs out.
 * Reporting a partial walk as if it were complete would understate the cost of
 * exactly the orders most likely to be refused.
 */
export function walkBook(
  book: OrderBook,
  side: Side,
  baseQty: number,
): { avgPrice: number; filled: number; levelsUsed: number; exhausted: boolean } {
  const levels = side === "BUY" ? book.asks : book.bids;
  let remaining = baseQty;
  let cost = 0;
  let used = 0;

  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.qty);
    cost += take * level.price;
    remaining -= take;
    used++;
  }

  const filled = baseQty - remaining;
  return {
    avgPrice: filled > 0 ? cost / filled : 0,
    filled,
    levelsUsed: used,
    exhausted: remaining > 1e-12,
  };
}

/** Resting notional within `windowBps` of mid on the side that would be hit. */
export function depthWithin(book: OrderBook, side: Side, mid: number, windowBps: number): number {
  const levels = side === "BUY" ? book.asks : book.bids;
  const limit = side === "BUY" ? mid * (1 + windowBps / 10_000) : mid * (1 - windowBps / 10_000);
  let notional = 0;
  for (const level of levels) {
    const inside = side === "BUY" ? level.price <= limit : level.price >= limit;
    if (!inside) break;
    notional += level.price * level.qty;
  }
  return notional;
}

/**
 * Queue ahead of a maker order resting at the touch.
 *
 * Used to estimate fill probability. Only the size at that single price counts:
 * an order joining the back of the queue at the best bid is behind exactly what
 * already rests there, not behind the whole book.
 */
export function queueAhead(book: OrderBook, side: Side): number {
  const levels = side === "BUY" ? book.bids : book.asks;
  return levels[0]?.qty ?? 0;
}
