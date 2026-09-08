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
  adverseSelection,
  EXCHANGE_LATENCY_MS,
  fetchAggTrades,
  priceVolatilityBps,
  SETTLEMENT_MS,
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
      s.mid,
      s.bestBid,
      s.bestAsk,
      s.book.lastUpdateId,
      s.book.bids.map((l) => [l.price, l.qty]),
      s.book.asks.map((l) => [l.price, l.qty]),
      s.filters.stepSize,
      s.filters.tickSize,
      s.filters.minNotional,
      // The asset names are not decoration: the wallet's service fee is decided
      // by which assets are being swapped, and that is worth 50 basis points on
      // its own. A snapshot that differed only here would otherwise hash the
      // same and price differently.
      s.filters.baseAsset,
      s.filters.quoteAsset,
      s.commission.maker,
      s.commission.taker,
      s.commission.source,
      Number(s.flow.hitsBidPerSec.toFixed(6)),
      Number(s.flow.liftsAskPerSec.toFixed(6)),
      Number(s.flow.windowSec.toFixed(3)),
      Number(s.flow.adverseBuyBps.toFixed(6)),
      Number(s.flow.adverseSellBps.toFixed(6)),
      s.flow.adverseSamples,
      Number(s.flow.volExchangeBps.toFixed(6)),
      Number(s.flow.volSettlementBps.toFixed(6)),
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
  const rates = tradeRates(trades);
  const adverse = adverseSelection(trades);
  const flow = {
    ...rates,
    adverseBuyBps: adverse.restingBuyBps,
    adverseSellBps: adverse.restingSellBps,
    adverseSamples: adverse.samples,
    volExchangeBps: priceVolatilityBps(trades, EXCHANGE_LATENCY_MS),
    volSettlementBps: priceVolatilityBps(trades, SETTLEMENT_MS),
  };

  assertUsableBook(book, symbol);

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
    // A level that is not a real level is skipped rather than consumed. A
    // negative quantity is the one that matters: `remaining -= -5` increases
    // what is left to fill and lowers the running cost, so a single corrupt
    // level produces an average price that was never available anywhere.
    if (!Number.isFinite(level.price) || !Number.isFinite(level.qty)) continue;
    if (level.price <= 0 || level.qty <= 0) continue;

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
    if (!Number.isFinite(level.price) || !Number.isFinite(level.qty)) continue;
    if (level.price <= 0 || level.qty <= 0) continue;
    const inside = side === "BUY" ? level.price <= limit : level.price >= limit;
    if (!inside) break;
    notional += level.price * level.qty;
  }
  return notional;
}

/**
 * Refuse a book that cannot be traded against.
 *
 * These are conditions an exchange should not produce and occasionally does:
 * a market crossed during a halt or a feed glitch, an empty side, prices that
 * are not numbers. Each of them still walks and still returns a figure, which
 * is worse than failing — a cost computed from a broken book is a number with
 * no market behind it, and everything downstream treats it as real.
 */
export function assertUsableBook(book: OrderBook, symbol: string): void {
  const bestBid = book.bids[0];
  const bestAsk = book.asks[0];

  if (!bestBid || !bestAsk) {
    throw new SnapshotError(
      `${symbol} has an empty ${!bestBid ? "bid" : "ask"} side. There is nothing to trade against.`,
    );
  }
  if (!Number.isFinite(bestBid.price) || !Number.isFinite(bestAsk.price)) {
    throw new SnapshotError(`${symbol} returned a book with a price that is not a number.`);
  }
  if (bestBid.price >= bestAsk.price) {
    throw new SnapshotError(
      `${symbol} is crossed: the best bid ${bestBid.price} is at or above the best ask ` +
        `${bestAsk.price}. That is a halted or broken market, not a spread to trade.`,
    );
  }

  // Sorting is the exchange's job, but a mis-sorted side would be walked in the
  // wrong order and quietly overstate the cost of every order.
  const misordered =
    book.asks.some((l, i) => i > 0 && l.price < book.asks[i - 1]!.price) ||
    book.bids.some((l, i) => i > 0 && l.price > book.bids[i - 1]!.price);
  if (misordered) {
    throw new SnapshotError(
      `${symbol} returned a book that is not in price order, so walking it would price the order ` +
        `against levels in the wrong sequence.`,
    );
  }
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
