/**
 * Public Binance market data.
 *
 * These endpoints need no API key and move no money, so Guardrail can price risk
 * honestly against the live book before a user has connected any credentials at
 * all. Everything here is read-only by construction.
 */

const BASE = process.env.BINANCE_API_BASE ?? "https://api.binance.com";
const TIMEOUT_MS = 8000;

export class MarketDataError extends Error {
  // Written as a plain field rather than a parameter property so the file stays
  // erasable TypeScript, which is what `node --experimental-strip-types` accepts.
  readonly detail: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = "MarketDataError";
    this.detail = detail;
  }
}

async function get<T>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // 451 is Binance's geo-block. Say so plainly rather than as a raw status.
      if (res.status === 451) {
        throw new MarketDataError(
          "Binance returned 451 (region blocked). Live prices are unavailable from this network. " +
            "Pass --price to supply a mark price manually.",
        );
      }
      throw new MarketDataError(`Binance ${res.status} on ${path}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof MarketDataError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new MarketDataError(`Binance request timed out after ${TIMEOUT_MS}ms.`);
    }
    throw new MarketDataError(`Could not reach Binance: ${(err as Error).message}`, err);
  } finally {
    clearTimeout(timer);
  }
}

export async function getMarkPrice(symbol: string): Promise<number> {
  const data = await get<{ symbol: string; price: string }>(
    `/api/v3/ticker/price?symbol=${encodeURIComponent(symbol.toUpperCase())}`,
  );
  const price = Number(data.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new MarketDataError(`Binance returned an unusable price for ${symbol}: ${data.price}`);
  }
  return price;
}

export interface Ticker24h {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  quoteVolume: number;
}

export async function get24h(symbol: string): Promise<Ticker24h> {
  const d = await get<Record<string, string>>(
    `/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol.toUpperCase())}`,
  );
  return {
    symbol: d.symbol ?? symbol,
    lastPrice: Number(d.lastPrice),
    priceChangePercent: Number(d.priceChangePercent),
    highPrice: Number(d.highPrice),
    lowPrice: Number(d.lowPrice),
    quoteVolume: Number(d.quoteVolume),
  };
}

/**
 * Resolve a mark price, preferring an explicit override.
 *
 * The override exists so the tool stays usable where Binance is geo-blocked, and
 * so tests and demos are deterministic. The returned `source` is carried into the
 * audit log so a decision never hides which price it was made against.
 */
export async function resolveMarkPrice(
  symbol: string,
  override?: number,
): Promise<{ price: number; source: "live" | "override" }> {
  if (override !== undefined) {
    if (!(override > 0)) throw new MarketDataError("--price must be greater than zero.");
    return { price: override, source: "override" };
  }
  return { price: await getMarkPrice(symbol), source: "live" };
}
