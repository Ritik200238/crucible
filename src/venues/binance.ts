/**
 * Binance spot market data.
 *
 * Public endpoints only. No key, no signature, nothing that can move money, so
 * the sampler and every quote path work before a credential exists anywhere.
 *
 * Endpoint weights are from Binance's own documentation and matter here: the
 * sampler runs continuously, so it stays on the cheap variants. Depth is only
 * ever requested at limit 100 (weight 5); asking for 5000 would cost 250 and
 * buy us nothing, because no order this product routes reaches that deep.
 */

import type {
  BookLevel,
  CommissionRates,
  OrderBook,
  SymbolFilters,
} from "../types.ts";

export const MAINNET = "https://api.binance.com";
export const DEMO = "https://demo-api.binance.com";

/** Overridable so the sampler and tests can point at Demo Mode or a mirror. */
export const BASE = process.env.BINANCE_API_BASE ?? MAINNET;

const TIMEOUT_MS = 10_000;

export class BinanceError extends Error {
  readonly status: number | null;
  readonly retryAfterSec: number | null;

  constructor(message: string, status: number | null = null, retryAfterSec: number | null = null) {
    super(message);
    this.name = "BinanceError";
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

async function get<T>(path: string, base = BASE): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 451) {
        throw new BinanceError(
          "Binance returned 451 (region blocked). Market data is unavailable from this network. " +
            "Set BINANCE_API_BASE to a reachable endpoint.",
          451,
        );
      }
      // 429 is a rate-limit warning, 418 is an IP ban for ignoring 429s.
      if (res.status === 429 || res.status === 418) {
        const retry = Number(res.headers.get("retry-after"));
        throw new BinanceError(
          `Binance rate limited this client (${res.status}). ` +
            (Number.isFinite(retry) ? `Retry after ${retry}s.` : "Back off before retrying."),
          res.status,
          Number.isFinite(retry) ? retry : null,
        );
      }
      throw new BinanceError(`Binance ${res.status} on ${path}: ${body.slice(0, 200)}`, res.status);
    }

    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof BinanceError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new BinanceError(`Binance request timed out after ${TIMEOUT_MS}ms.`);
    }
    throw new BinanceError(`Could not reach Binance: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

function num(v: unknown, field: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BinanceError(`Binance returned an unusable ${field}: ${String(v)}`);
  return n;
}

/** Order book, top `limit` levels each side. Weight 5 at limit <= 100. */
export async function fetchOrderBook(symbol: string, limit = 100): Promise<OrderBook> {
  if (limit > 100) {
    throw new BinanceError(
      `Depth is only requested at limit <= 100 (weight 5); ${limit} would cost far more weight for depth no routed order reaches.`,
    );
  }
  const raw = await get<{ lastUpdateId: number; bids: [string, string][]; asks: [string, string][] }>(
    `/api/v3/depth?symbol=${encodeURIComponent(symbol.toUpperCase())}&limit=${limit}`,
  );
  const level = ([p, q]: [string, string]): BookLevel => ({
    price: num(p, "book price"),
    qty: num(q, "book quantity"),
  });
  return {
    lastUpdateId: raw.lastUpdateId,
    bids: raw.bids.map(level),
    asks: raw.asks.map(level),
  };
}

export interface BookTicker {
  symbol: string;
  bidPrice: number;
  bidQty: number;
  askPrice: number;
  askQty: number;
}

/** Best bid and ask. Weight 2 for a single symbol. */
export async function fetchBookTicker(symbol: string): Promise<BookTicker> {
  const d = await get<Record<string, string>>(
    `/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(symbol.toUpperCase())}`,
  );
  return {
    symbol: d.symbol ?? symbol.toUpperCase(),
    bidPrice: num(d.bidPrice, "bidPrice"),
    bidQty: num(d.bidQty, "bidQty"),
    askPrice: num(d.askPrice, "askPrice"),
    askQty: num(d.askQty, "askQty"),
  };
}

/**
 * Mid price alone, at weight 2.
 *
 * Sizing an order in dollars needs a price before the real snapshot can be
 * taken at the right quantity. Doing that with a full snapshot costs the book,
 * the filters and the tape as well, and every one of them is discarded — around
 * thirty weight and half a second to learn one number.
 */
export async function fetchMid(symbol: string): Promise<number> {
  const t = await fetchBookTicker(symbol);
  const mid = (t.bidPrice + t.askPrice) / 2;
  if (!(mid > 0)) throw new BinanceError(`${symbol.toUpperCase()} has no usable mid price.`);
  return mid;
}

interface RawFilter {
  filterType: string;
  stepSize?: string;
  minQty?: string;
  maxQty?: string;
  tickSize?: string;
  minNotional?: string;
}

interface RawSymbol {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  baseAssetPrecision: number;
  quoteAssetPrecision: number;
  filters: RawFilter[];
}

/**
 * Trading rules for a symbol.
 *
 * Every field here is a way an order can be rejected, so they are read from the
 * exchange rather than assumed. A quantity that does not sit on `stepSize`, or a
 * notional under `minNotional`, is refused by Binance no matter how good the
 * routing decision was.
 */
/**
 * Symbol filters, cached.
 *
 * This is the most expensive call the product makes at weight 20, and it
 * returns rules that change on the order of weeks. Re-fetching it on every
 * quote spent more weight than the book and the tape combined.
 *
 * The TTL is an hour rather than forever: a changed step size or minimum
 * notional makes an order rejected outright, so the cache has to expire on its
 * own rather than only on restart.
 */
const FILTER_TTL_MS = 60 * 60 * 1000;
const filterCache = new Map<string, { at: number; filters: SymbolFilters }>();

export function clearFilterCache(): void {
  filterCache.clear();
}

export async function fetchSymbolFilters(symbol: string, now = Date.now()): Promise<SymbolFilters> {
  const upper = symbol.toUpperCase();
  const cached = filterCache.get(upper);
  if (cached && now - cached.at < FILTER_TTL_MS) return cached.filters;
  const raw = await get<{ symbols: RawSymbol[] }>(
    `/api/v3/exchangeInfo?symbol=${encodeURIComponent(upper)}`,
  );
  const s = raw.symbols?.[0];
  if (!s) throw new BinanceError(`Binance does not list a symbol called ${upper}.`);
  if (s.status !== "TRADING") {
    throw new BinanceError(`${upper} is not trading right now (status ${s.status}).`);
  }

  const find = (type: string) => s.filters.find((f) => f.filterType === type);
  const lot = find("LOT_SIZE");
  const price = find("PRICE_FILTER");
  const notional = find("NOTIONAL") ?? find("MIN_NOTIONAL");

  if (!lot?.stepSize || !price?.tickSize) {
    throw new BinanceError(`${upper} is missing LOT_SIZE or PRICE_FILTER; cannot size an order safely.`);
  }

  const filters: SymbolFilters = {
    symbol: s.symbol,
    baseAsset: s.baseAsset,
    quoteAsset: s.quoteAsset,
    baseAssetPrecision: s.baseAssetPrecision,
    quoteAssetPrecision: s.quoteAssetPrecision,
    stepSize: num(lot.stepSize, "stepSize"),
    minQty: num(lot.minQty ?? "0", "minQty"),
    maxQty: num(lot.maxQty ?? "0", "maxQty"),
    tickSize: num(price.tickSize, "tickSize"),
    minNotional: notional?.minNotional ? num(notional.minNotional, "minNotional") : 0,
  };
  filterCache.set(upper, { at: now, filters });
  return filters;
}

/**
 * The public VIP-0 schedule, used when no account credential is present.
 *
 * Labelled `vip0-default` so every report that uses it can say the fee was
 * assumed rather than read. The real rate is lower for anyone paying in BNB or
 * above VIP 0, which would only make Binance look cheaper than we claim.
 */
export const VIP0: CommissionRates = { maker: 0.001, taker: 0.001, source: "vip0-default" };

/** Round a quantity down onto the symbol's step size. */
export function roundToStep(qty: number, stepSize: number): number {
  if (!(stepSize > 0)) return qty;
  const steps = Math.floor(qty / stepSize + 1e-9);
  const out = steps * stepSize;
  // Binary floating point leaves dust like 0.30000000000000004; the exchange
  // rejects that on precision, so snap to the step's own decimal places.
  const decimals = (stepSize.toString().split(".")[1] ?? "").length;
  return Number(out.toFixed(decimals));
}

/** Round a price onto the symbol's tick size. */
export function roundToTick(price: number, tickSize: number): number {
  if (!(tickSize > 0)) return price;
  const ticks = Math.round(price / tickSize);
  const decimals = (tickSize.toString().split(".")[1] ?? "").length;
  return Number((ticks * tickSize).toFixed(decimals));
}

export interface AggTrade {
  price: number;
  qty: number;
  time: number;
  /** True when the buyer was the maker, i.e. a seller hit the bid. */
  buyerIsMaker: boolean;
}

/**
 * Recent aggregated trades. Weight 4, versus 25 for the raw trade feed.
 *
 * Used to measure how fast volume is actually arriving on each side, which is
 * the only honest basis for saying whether a resting order would get filled.
 */
export async function fetchAggTrades(symbol: string, limit = 500): Promise<AggTrade[]> {
  const raw = await get<{ p: string; q: string; T: number; m: boolean }[]>(
    `/api/v3/aggTrades?symbol=${encodeURIComponent(symbol.toUpperCase())}&limit=${Math.min(limit, 1000)}`,
  );
  return raw.map((t) => ({
    price: num(t.p, "trade price"),
    qty: num(t.q, "trade quantity"),
    time: t.T,
    buyerIsMaker: t.m === true,
  }));
}

/**
 * Base-asset volume per second arriving on each side, over the sampled window.
 *
 * `hitsBid` is volume from sellers crossing into the bid — the flow that fills a
 * resting buy order. `liftsAsk` is the mirror. Splitting them matters: a market
 * can be busy on one side and dead on the other, and averaging the two would
 * claim a resting order is about to fill when nothing is coming for it.
 */
export function tradeRates(trades: AggTrade[]): {
  hitsBidPerSec: number;
  liftsAskPerSec: number;
  windowSec: number;
} {
  if (trades.length < 2) return { hitsBidPerSec: 0, liftsAskPerSec: 0, windowSec: 0 };

  const first = Math.min(...trades.map((t) => t.time));
  const last = Math.max(...trades.map((t) => t.time));
  const windowSec = Math.max(1, (last - first) / 1000);

  let hitsBid = 0;
  let liftsAsk = 0;
  for (const t of trades) {
    if (t.buyerIsMaker) hitsBid += t.qty;
    else liftsAsk += t.qty;
  }
  return {
    hitsBidPerSec: hitsBid / windowSec,
    liftsAskPerSec: liftsAsk / windowSec,
    windowSec,
  };
}


/** How far the market moves against a passive fill, measured from the tape. */
export interface AdverseSelection {
  /** Cost in bps to an order resting on the bid. Positive means it hurt. */
  restingBuyBps: number;
  /** Cost in bps to an order resting on the ask. */
  restingSellBps: number;
  /** Fills each figure was averaged over. A small count is a weak measurement. */
  samples: number;
  horizonMs: number;
}

/**
 * Adverse selection, measured rather than assumed.
 *
 * This is the cost that makes passive execution harder than it looks, and it is
 * the one most cost models leave out. A resting bid does not fill at random: it
 * fills when someone chose to sell into it, and that someone is more often right
 * than wrong over the next few seconds. So the fill is systematically worse than
 * the price it printed at.
 *
 * It is computed here by asking what actually happened after each passive fill
 * in the recent tape: take every trade where a seller crossed into the bid, and
 * compare its price against the volume-weighted price of everything that traded
 * in the following few seconds. If the market kept falling, a buyer resting on
 * that bid was picked off, and by how much.
 *
 * The sign convention is that positive is a cost. A negative figure means flow
 * in this window was uninformative and passive fills came out ahead, which does
 * happen over short samples and is reported as measured rather than floored at
 * zero.
 */
export function adverseSelection(trades: AggTrade[], horizonMs = 5000): AdverseSelection {
  const empty: AdverseSelection = {
    restingBuyBps: 0,
    restingSellBps: 0,
    samples: 0,
    horizonMs,
  };
  if (trades.length < 20) return empty;

  // aggTrades arrives oldest first, so a forward pointer over a sorted series
  // avoids rescanning the tape for every fill.
  const sorted = [...trades].sort((a, b) => a.time - b.time);

  let buySum = 0;
  let buyCount = 0;
  let sellSum = 0;
  let sellCount = 0;

  let head = 0;
  for (let i = 0; i < sorted.length; i++) {
    const fill = sorted[i]!;
    while (head < sorted.length && sorted[head]!.time <= fill.time) head++;

    let notional = 0;
    let volume = 0;
    for (let j = head; j < sorted.length && sorted[j]!.time <= fill.time + horizonMs; j++) {
      notional += sorted[j]!.price * sorted[j]!.qty;
      volume += sorted[j]!.qty;
    }
    // Too little traded afterwards to say anything about where the price went.
    if (volume <= 0) continue;

    const after = notional / volume;
    const driftBps = ((after - fill.price) / fill.price) * 10_000;

    if (fill.buyerIsMaker) {
      // A seller crossed into the bid, so a resting buyer was filled here. The
      // market falling afterwards is a cost to that buyer.
      buySum += -driftBps;
      buyCount++;
    } else {
      // A buyer lifted the ask, filling a resting seller. The market rising
      // afterwards is a cost to that seller.
      sellSum += driftBps;
      sellCount++;
    }
  }

  if (buyCount === 0 && sellCount === 0) return empty;

  return {
    restingBuyBps: buyCount > 0 ? buySum / buyCount : 0,
    restingSellBps: sellCount > 0 ? sellSum / sellCount : 0,
    samples: Math.min(buyCount, sellCount),
    horizonMs,
  };
}
