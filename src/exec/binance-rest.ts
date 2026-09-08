/**
 * Signed Binance REST client.
 *
 * The exchange leg of execution. Three things here are deliberate and worth
 * stating, because each of them is a way execution tools quietly lie:
 *
 *   1. Every order is validated by Binance's own `/order/test` before it is
 *      sent. Symbol filters, lot size, notional minimums and precision are the
 *      exchange's rules, and asking it is more honest than reimplementing them.
 *   2. A fill is never taken from the response that placed the order. It is
 *      confirmed by reading the order back, and the fees and maker flag come
 *      from the trade records, not from an assumption.
 *   3. The base URL decides whether this is practice or real money, so it is
 *      never defaulted to mainnet. It has to be chosen.
 */

import { createHmac, createPrivateKey, sign as cryptoSign } from "node:crypto";
import type { ConfirmedFill, FeeCharge, FillStatus, SymbolFilters } from "../types.ts";

/** Live exchange. Real money. */
export const MAINNET = "https://api.binance.com";
/** Practice account with live-like books, identical filters and limits. */
export const DEMO = "https://demo-api.binance.com";
/** Separate test network with its own, independent book. */
export const TESTNET = "https://testnet.binance.vision";

export class BinanceApiError extends Error {
  readonly status: number | null;
  /** Binance's own error code, e.g. -2010 for insufficient balance. */
  readonly code: number | null;

  constructor(message: string, status: number | null = null, code: number | null = null) {
    super(message);
    this.name = "BinanceApiError";
    this.status = status;
    this.code = code;
  }
}

export interface Credentials {
  apiKey: string;
  /** HMAC secret, or a PKCS#8 PEM private key for Ed25519. */
  secret: string;
  /** Which signing scheme the key uses. */
  scheme: "HMAC" | "ED25519";
}

/**
 * Read credentials from the environment.
 *
 * Nothing here has a default. A missing key must fail loudly rather than fall
 * through to an unauthenticated call that looks like it worked.
 */
export function credentialsFromEnv(prefix = "BINANCE"): Credentials {
  const apiKey = process.env[`${prefix}_API_KEY`];
  const secret = process.env[`${prefix}_API_SECRET`];
  if (!apiKey || !secret) {
    throw new BinanceApiError(
      `Set ${prefix}_API_KEY and ${prefix}_API_SECRET. For practice, create them at ` +
        `demo.binance.com under API Management and set CRUCIBLE_BINANCE_BASE to the Demo Mode URL.`,
    );
  }
  const scheme = secret.includes("PRIVATE KEY") ? "ED25519" : "HMAC";
  return { apiKey, secret, scheme };
}

/**
 * Sign a query string.
 *
 * Ed25519 signatures are base64 and case-sensitive; HMAC signatures are hex and
 * are not. Both cover the query string exactly as it will be sent, so the
 * signature is computed from the same string that goes on the wire rather than
 * from a re-serialisation of the parameters.
 */
export function signQuery(query: string, creds: Credentials): string {
  if (creds.scheme === "ED25519") {
    const key = createPrivateKey(creds.secret);
    return cryptoSign(null, Buffer.from(query), key).toString("base64");
  }
  return createHmac("sha256", creds.secret).update(query).digest("hex");
}

export interface ClientOptions {
  baseUrl: string;
  credentials: Credentials;
  /** Milliseconds a request stays valid for. Binance caps this at 60000. */
  recvWindow?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface OrderResponse {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  transactTime: number;
  price: string;
  origQty: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  status: string;
  type: string;
  side: string;
  fills?: { price: string; qty: string; commission: string; commissionAsset: string; tradeId: number }[];
}

interface TradeRecord {
  id: number;
  orderId: number;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  isMaker: boolean;
  time: number;
}

export class BinanceRest {
  readonly baseUrl: string;
  private readonly creds: Credentials;
  private readonly recvWindow: number;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;
  /** Offset between this machine's clock and Binance's, learned once. */
  private clockOffsetMs = 0;

  constructor(opts: ClientOptions) {
    if (!opts.baseUrl) {
      throw new BinanceApiError(
        "A base URL is required. Choose Demo Mode or mainnet explicitly rather than defaulting to real money.",
      );
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.creds = opts.credentials;
    // Clamped at both ends. Binance caps it at 60000, and a zero or negative
    // window is rejected outright — silently forwarding one would turn a
    // configuration slip into an unexplained rejection at send time.
    this.recvWindow = Math.min(Math.max(opts.recvWindow ?? 5000, 1), 60_000);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  get isMainnet(): boolean {
    return this.baseUrl === MAINNET;
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    signed: boolean,
  ): Promise<T> {
    const entries = Object.entries(params).filter(([, v]) => v !== undefined);
    if (signed) {
      entries.push(["timestamp", Date.now() + this.clockOffsetMs]);
      entries.push(["recvWindow", this.recvWindow]);
    }
    let query = entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
    if (signed) query += `&signature=${encodeURIComponent(signQuery(query, this.creds))}`;

    const url = `${this.baseUrl}${path}${query ? `?${query}` : ""}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.doFetch(url, {
        method,
        signal: controller.signal,
        headers: { "X-MBX-APIKEY": this.creds.apiKey, accept: "application/json" },
      });
      const text = await res.text();

      if (!res.ok) {
        let code: number | null = null;
        let msg = text.slice(0, 300);
        try {
          const body = JSON.parse(text) as { code?: number; msg?: string };
          code = body.code ?? null;
          if (body.msg) msg = body.msg;
        } catch {
          /* keep the raw text */
        }
        if (res.status === 429 || res.status === 418) {
          throw new BinanceApiError(
            `Binance rate limited this client (${res.status}). Back off before retrying.`,
            res.status,
            code,
          );
        }
        throw new BinanceApiError(`Binance rejected ${method} ${path}: ${msg}`, res.status, code);
      }
      return (text ? JSON.parse(text) : {}) as T;
    } catch (err) {
      if (err instanceof BinanceApiError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new BinanceApiError(`Binance request timed out after ${this.timeoutMs}ms.`);
      }
      throw new BinanceApiError(`Could not reach Binance: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Learn the clock offset against Binance.
   *
   * A signed request is rejected when the timestamp falls outside `recvWindow`,
   * and a laptop clock drifting by a few seconds is the most common reason an
   * otherwise correct integration fails. Measuring it once removes that class of
   * failure entirely.
   */
  async syncClock(): Promise<number> {
    const before = Date.now();
    const { serverTime } = await this.request<{ serverTime: number }>(
      "GET",
      "/api/v3/time",
      {},
      false,
    );
    const rtt = Date.now() - before;
    this.clockOffsetMs = serverTime - (before + rtt / 2);
    return this.clockOffsetMs;
  }

  /** Balances, permissions and the account's real commission rates. */
  async account(): Promise<{
    canTrade: boolean;
    balances: { asset: string; free: number; locked: number }[];
    maker: number;
    taker: number;
  }> {
    const raw = await this.request<{
      canTrade: boolean;
      commissionRates: { maker: string; taker: string };
      balances: { asset: string; free: string; locked: string }[];
    }>("GET", "/api/v3/account", { omitZeroBalances: true }, true);

    return {
      canTrade: raw.canTrade,
      balances: raw.balances.map((b) => ({
        asset: b.asset,
        free: Number(b.free),
        locked: Number(b.locked),
      })),
      maker: Number(raw.commissionRates.maker),
      taker: Number(raw.commissionRates.taker),
    };
  }

  /**
   * Ask Binance whether it would accept this order, without placing it.
   *
   * Weight 1, and it applies the real filters. Running this first turns a whole
   * class of rejections into a refusal before anything is transmitted.
   */
  async testOrder(params: Record<string, string | number | undefined>): Promise<void> {
    await this.request("POST", "/api/v3/order/test", params, true);
  }

  /** Place an order. The response is not treated as proof it filled. */
  async newOrder(params: Record<string, string | number | undefined>): Promise<OrderResponse> {
    return this.request<OrderResponse>(
      "POST",
      "/api/v3/order",
      { ...params, newOrderRespType: "FULL" },
      true,
    );
  }

  async queryOrder(symbol: string, orderId: number): Promise<OrderResponse> {
    return this.request<OrderResponse>("GET", "/api/v3/order", { symbol, orderId }, true);
  }

  async myTrades(symbol: string, orderId: number): Promise<TradeRecord[]> {
    return this.request<TradeRecord[]>("GET", "/api/v3/myTrades", { symbol, orderId }, true);
  }

  /**
   * Wait for an order to reach a state it will not leave.
   *
   * `NEW` and `PARTIALLY_FILLED` are not terminal. Reporting either as done is
   * how a tool ends up telling someone a trade completed while it is still
   * sitting on the book.
   */
  async awaitTerminal(
    symbol: string,
    orderId: number,
    { timeoutMs = 30_000, pollMs = 500 } = {},
  ): Promise<OrderResponse> {
    const terminal = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED", "EXPIRED_IN_MATCH"]);
    const deadline = Date.now() + timeoutMs;
    let last = await this.queryOrder(symbol, orderId);

    while (!terminal.has(last.status)) {
      if (Date.now() > deadline) {
        throw new BinanceApiError(
          `Order ${orderId} on ${symbol} is still ${last.status} after ${Math.round(timeoutMs / 1000)}s. ` +
            `It has not failed — it is unresolved, and reporting it either way would be a guess. ` +
            `Its notional stays held against your caps. Read it back with: crucible reconcile --plan <plan id>`,
        );
      }
      await new Promise((r) => setTimeout(r, pollMs));
      last = await this.queryOrder(symbol, orderId);
    }
    return last;
  }
}

const STATUS_MAP: Record<string, FillStatus> = {
  FILLED: "FILLED",
  PARTIALLY_FILLED: "PARTIAL",
  CANCELED: "FAILED",
  REJECTED: "FAILED",
  EXPIRED: "FAILED",
  EXPIRED_IN_MATCH: "FAILED",
  NEW: "PENDING",
};

/**
 * Build a confirmed fill from the re-read order and its trade records.
 *
 * The trades are the source of truth for price, fee and the maker flag. A
 * partially filled order that then expired still moved money, so it is reported
 * as PARTIAL with what actually traded rather than as an outright failure.
 */
export function toConfirmedFill(
  order: OrderResponse,
  trades: TradeRecord[],
  filters: SymbolFilters,
): ConfirmedFill {
  const executed = Number(order.executedQty);
  const quote = Number(order.cummulativeQuoteQty);
  const avgPrice = executed > 0 ? quote / executed : 0;

  const byAsset = new Map<string, number>();
  for (const t of trades) {
    byAsset.set(t.commissionAsset, (byAsset.get(t.commissionAsset) ?? 0) + Number(t.commission));
  }

  // An order's commission can be split across assets when a discount runs out
  // part way through. Every one is carried: reducing them to a single "largest"
  // both loses money from the receipt and picks wrongly, because raw amounts in
  // different assets are not comparable.
  //
  // A fee in the quote asset is already priced. One in the base asset converts
  // at the fill's own average price. Anything else — a discount asset that is
  // neither leg — cannot be priced from this order alone, so it is reported
  // unpriced rather than guessed at or silently dropped.
  const fees: FeeCharge[] = [...byAsset.entries()].map(([asset, amount]) => {
    let valueInQuote: number | null = null;
    if (asset === filters.quoteAsset) valueInQuote = amount;
    else if (asset === filters.baseAsset && avgPrice > 0) valueInQuote = amount * avgPrice;
    return { asset, amount, valueInQuote };
  });

  const priced = fees.filter((f) => f.valueInQuote !== null);
  const totalFeeInQuote =
    priced.length > 0 ? priced.reduce((a, f) => a + f.valueInQuote!, 0) : fees.length === 0 ? 0 : null;

  const makerFlags = new Set(trades.map((t) => t.isMaker));

  let status = STATUS_MAP[order.status] ?? "PENDING";
  if (status === "FAILED" && executed > 0) status = "PARTIAL";

  return {
    venue: "BINANCE_SPOT",
    status,
    filledBaseQty: executed,
    filledQuoteQty: quote,
    avgPrice,
    fees,
    totalFeeInQuote,
    isMaker: makerFlags.size === 1 ? [...makerFlags][0]! : null,
    reference: String(order.orderId),
    confirmedBy: `GET /api/v3/order plus ${trades.length} trade record(s)`,
  };
}
