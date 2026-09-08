/**
 * The executable on-chain quote.
 *
 * Everything else on the on-chain side is read from the pool directly, which is
 * the honest way to price it but is not the thing that actually fills. The
 * wallet routes its own way and charges its own fee, so its quote is the one an
 * order would really get.
 *
 * Having both is the point. Two independent sources for the same price mean a
 * disagreement is detectable, and a disagreement means one of them is wrong
 * without saying which — which is exactly when an order should not be sent.
 *
 * This is opt-in because it costs a subprocess. The sampler runs continuously
 * and prices from the pool alone; the routing path, where an order might
 * actually be transmitted, asks the wallet as well.
 */

import { NATIVE_BNB, TOKENS } from "./onchain.ts";
import { quoteSwap, walletStatus } from "../exec/wallet.ts";
import type { Side, WalletQuote } from "../types.ts";

/**
 * Whether a wallet session exists, cached.
 *
 * Checking costs a process spawn of a second or more. Doing that on every
 * snapshot would dominate the latency of a quote, and the answer does not
 * change often enough to be worth it.
 */
let sessionCache: { at: number; connected: boolean } | null = null;
const SESSION_TTL_MS = 60_000;

export async function hasWalletSession(now = Date.now()): Promise<boolean> {
  if (sessionCache && now - sessionCache.at < SESSION_TTL_MS) return sessionCache.connected;
  try {
    const status = await walletStatus();
    sessionCache = { at: now, connected: status.connected };
  } catch {
    // No CLI, no session, or the CLI refused. All of them mean the same thing
    // here: there is no executable quote to be had.
    sessionCache = { at: now, connected: false };
  }
  return sessionCache.connected;
}

/** Clears the cached session check. Used by tests and after a sign-in. */
export function resetSessionCache(): void {
  sessionCache = null;
}

export interface WalletQuoteRequest {
  baseAsset: string;
  quoteAsset: string;
  side: Side;
  baseQty: number;
  /** Used to size the input leg of a buy, which is denominated in the quote asset. */
  midPrice: number;
}

/**
 * Ask the wallet what this swap would pay out.
 *
 * Returns null rather than throwing whenever the quote cannot be had — no
 * session, no CLI, an unlisted token, a wallet-side refusal. A missing second
 * opinion is a normal condition and must not lose the pool price that did
 * arrive; the disagreement rule simply has nothing to compare and stands down.
 */
export async function fetchWalletQuote(req: WalletQuoteRequest): Promise<WalletQuote | null> {
  if (!(await hasWalletSession())) return null;

  const base = TOKENS[req.baseAsset.toUpperCase()];
  const quote = TOKENS[req.quoteAsset.toUpperCase()];
  if (!base || !quote) return null;

  const buying = req.side === "BUY";
  // Native BNB is addressed by its sentinel when it is being spent or received;
  // the wallet wraps and unwraps as part of the swap.
  const baseAddress = base.symbol === "WBNB" ? NATIVE_BNB : base.address;
  const fromToken = buying ? quote.address : baseAddress;
  const toToken = buying ? baseAddress : quote.address;
  const fromTokenQty = buying ? req.baseQty * req.midPrice : req.baseQty;

  try {
    return await quoteSwap({
      fromToken,
      toToken,
      fromTokenQty: Number(fromTokenQty.toFixed(8)),
      slippage: "auto",
    });
  } catch {
    return null;
  }
}
