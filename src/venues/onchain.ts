/**
 * On-chain pricing: PancakeSwap V3 on BNB Smart Chain.
 *
 * Read-only. Prices come from the pool's own quoter over a public RPC, so this
 * side of the comparison needs no wallet, no key and no signature either.
 *
 * The quoter is asked on every fee tier rather than a chosen one. Which tier is
 * cheapest depends on size: the 0.01% pool has the tightest fee but the least
 * room, so a large order that would push through it can come out worse than the
 * same order in the 0.05% pool. Picking a tier up front would silently
 * mis-price exactly the trades this product exists to route.
 */

import type { OnchainQuote, OnchainTierQuote } from "../types.ts";

/** BNB Smart Chain mainnet. */
export const BSC_CHAIN_ID = 56;

export const RPC_URLS = (
  process.env.BSC_RPC_URLS ??
  "https://bsc-dataseed1.bnbchain.org,https://bsc-rpc.publicnode.com,https://bsc-dataseed2.bnbchain.org"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** PancakeSwap V3 QuoterV2 on BSC. */
export const QUOTER_V2 = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";

/**
 * Fee tiers, in hundredths of a basis point.
 *
 * 100 = 0.01%, 500 = 0.05%, 2500 = 0.25%, 10000 = 1%. The units trip people up,
 * so the conversion lives in `feeTierBps` rather than being inlined.
 */
export const FEE_TIERS = [100, 500, 2500, 10_000] as const;

/** A fee tier expressed in basis points of notional. */
export const feeTierBps = (tier: number) => tier / 100;

export interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
}

/**
 * Tokens we can price on-chain, keyed by the Binance base asset.
 *
 * Deliberately small. A token is only listed once its BSC contract has been
 * checked against the address the Agentic Wallet skill itself documents, since
 * routing to a look-alike contract is the one mistake here that costs real money.
 */
export const TOKENS: Record<string, TokenInfo> = {
  BNB: { symbol: "WBNB", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", decimals: 18 },
  ETH: { symbol: "ETH", address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", decimals: 18 },
  USDT: { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
  USDC: { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
};

/** Native BNB as the Agentic Wallet addresses it in swap commands. */
export const NATIVE_BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/** `quoteExactInputSingle((address,address,uint256,uint24,uint160))` */
const QUOTE_SELECTOR = "c6a5026a";

/** Gas a PancakeSwap V3 swap costs beyond the quoter's own estimate. */
const GAS_OVERHEAD = 60_000;

export class OnchainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnchainError";
  }
}

function word(hex: string): string {
  return hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let lastError = "";
  for (const url of RPC_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
      if (body.error) {
        lastError = `${url}: rpc error ${body.error.code} ${body.error.message}`;
        continue;
      }
      if (body.result === undefined) {
        lastError = `${url}: rpc returned no result`;
        continue;
      }
      return body.result;
    } catch (err) {
      lastError =
        (err as Error).name === "AbortError" ? `${url}: timed out` : `${url}: ${(err as Error).message}`;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new OnchainError(`Every BSC RPC failed for ${method}. Last error — ${lastError}`);
}

export async function gasPriceWei(): Promise<number> {
  const hex = await rpc<string>("eth_gasPrice", []);
  const wei = Number(BigInt(hex));
  if (!Number.isFinite(wei) || wei <= 0) throw new OnchainError(`Unusable gas price: ${hex}`);
  return wei;
}

/**
 * Ask the quoter what one fee tier would pay out.
 *
 * Returns null rather than throwing when a pool does not exist or has no
 * liquidity for this size: a missing tier is a normal condition, not an error,
 * and one absent pool must not lose the tiers that did answer.
 */
export async function quoteTier(
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: number,
  feeTier: number,
): Promise<OnchainTierQuote | null> {
  const amountInWei = BigInt(Math.round(amountIn * 10 ** tokenIn.decimals));
  const data =
    "0x" +
    QUOTE_SELECTOR +
    word(tokenIn.address) +
    word(tokenOut.address) +
    word(amountInWei.toString(16)) +
    word(feeTier.toString(16)) +
    word("0");

  let result: string;
  try {
    result = await rpc<string>("eth_call", [{ to: QUOTER_V2, data }, "latest"]);
  } catch {
    return null;
  }
  // (amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate)
  if (typeof result !== "string" || result.length < 2 + 64 * 4) return null;

  const at = (i: number) => BigInt("0x" + result.slice(2 + 64 * i, 2 + 64 * (i + 1)));
  const amountOut = Number(at(0)) / 10 ** tokenOut.decimals;
  if (!(amountOut > 0)) return null;

  return {
    feeTier,
    amountOut,
    price: amountOut / amountIn,
    gasEstimate: Number(at(3)),
  };
}

export interface OnchainQuoteOptions {
  baseAsset: string;
  quoteAsset: string;
  side: "BUY" | "SELL";
  /** Size in the base asset. */
  baseQty: number;
  /** Used to price gas, which is paid in BNB. */
  bnbPriceUsd: number;
}

/**
 * Price a trade on-chain across every fee tier.
 *
 * A BUY spends the quote asset to receive base, so the swap is quote-to-base and
 * the amount put in is `baseQty * price`. A SELL is the reverse. Getting this
 * backwards would compare a buy against a sell, so the direction is resolved
 * once, here, rather than at each call site.
 */
export async function quoteOnchain(opts: OnchainQuoteOptions): Promise<OnchainQuote> {
  const base = TOKENS[opts.baseAsset.toUpperCase()];
  const quote = TOKENS[opts.quoteAsset.toUpperCase()];
  if (!base || !quote) {
    throw new OnchainError(
      `No BSC contract on file for ${!base ? opts.baseAsset : opts.quoteAsset}. ` +
        `Priceable on-chain: ${Object.keys(TOKENS).join(", ")}.`,
    );
  }

  const buying = opts.side === "BUY";
  const tokenIn = buying ? quote : base;
  const tokenOut = buying ? base : quote;
  const amountIn = buying ? opts.baseQty * opts.bnbPriceUsd : opts.baseQty;

  const [tiers, gasWei] = await Promise.all([
    Promise.all(FEE_TIERS.map((t) => quoteTier(tokenIn, tokenOut, amountIn, t))),
    gasPriceWei(),
  ]);

  const answered = tiers.filter((t): t is OnchainTierQuote => t !== null);
  if (answered.length === 0) {
    throw new OnchainError(
      `No PancakeSwap V3 pool answered for ${tokenIn.symbol}/${tokenOut.symbol} at this size.`,
    );
  }

  // Best is the most output for the same input, which already accounts for the
  // pool fee and the price impact together.
  const best = answered.reduce((a, b) => (b.amountOut > a.amountOut ? b : a));
  const gasUnits = best.gasEstimate + GAS_OVERHEAD;
  const gasCostUsd = (gasUnits * gasWei) / 1e18 * opts.bnbPriceUsd;

  // A reference quote on the same tier at a size small enough to move the pool
  // almost none. Ten dollars, measured against the curve: on the deepest BNB
  // pool the price at $10 and at $0.10 agree to seven significant figures, so
  // this is comfortably inside the flat part. It is capped at the real size so a
  // trade smaller than the reference reports its impact as zero rather than
  // negative.
  const referenceIn = Math.min(amountIn, buying ? 10 : 10 / opts.bnbPriceUsd);
  const reference = await quoteTier(tokenIn, tokenOut, referenceIn, best.feeTier);

  return {
    chainId: BSC_CHAIN_ID,
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amountIn,
    tiers: answered,
    best,
    gasPriceWei: gasWei,
    gasCostUsd,
    referencePrice: reference ? reference.price : null,
    walletQuote: null,
  };
}

/**
 * Binance Wallet's service fee for a swap, as a fraction.
 *
 * Group 1 covers selected stablecoins and the native tokens of major chains, and
 * a Group 1 to Group 1 swap is free. Everything else is 0.5%, which is large
 * enough to decide the route on its own, so it is charged rather than ignored
 * when either side is outside the group.
 */
const GROUP_ONE = new Set(["BNB", "WBNB", "ETH", "USDT", "USDC", "FDUSD", "BTCB", "SOL"]);

export function walletServiceFeeRate(fromAsset: string, toAsset: string): number {
  const from = GROUP_ONE.has(fromAsset.toUpperCase());
  const to = GROUP_ONE.has(toAsset.toUpperCase());
  return from && to ? 0 : 0.005;
}
