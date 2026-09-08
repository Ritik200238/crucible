/**
 * Execution.
 *
 * Takes a plan and makes it real, on whichever venue the plan chose. Four rules
 * hold on both paths, and each of them exists because breaking it is how an
 * execution tool ends up reporting a trade that did not happen:
 *
 *   1. A plan is checked for expiry before anything is sent. Stale market state
 *      is re-priced, never replayed.
 *   2. Nothing is transmitted unless the policy says live and the environment
 *      agrees. Two switches, both held by a human.
 *   3. The response to the placing call is never treated as the outcome. The
 *      fill is read back from the venue on a separate call.
 *   4. Every attempt is written to the ledger, including the ones that failed
 *      and the ones that were refused.
 */

import { assertExecutable, RouteError } from "../decide/router.ts";
import { isLiveEnabled } from "../config.ts";
import { Ledger } from "../ledger/chain.ts";
import { NATIVE_BNB, TOKENS } from "../venues/onchain.ts";
import { roundToStep } from "../venues/binance.ts";
import {
  BinanceApiError,
  BinanceRest,
  toConfirmedFill,
  type Credentials,
} from "./binance-rest.ts";
import { executeSwap, walletLimits, walletStatus, WalletError } from "./wallet.ts";
import type {
  ConfirmedFill,
  Plan,
  Policy,
  Receipt,
  Side,
  Snapshot,
} from "../types.ts";

export class ExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionError";
  }
}

export interface ExecuteOptions {
  plan: Plan;
  snapshot: Snapshot;
  policy: Policy;
  /** Required to reach the exchange. Absent means the Binance leg cannot run. */
  binance?: { baseUrl: string; credentials: Credentials };
  ledger?: Ledger;
  now?: number;
}

/**
 * Refuse to transmit unless both switches agree.
 *
 * Separated from the execution path so the reason can be reported before any
 * work is done, and so the check cannot be skipped by a caller that forgets it.
 */
export function assertLive(policy: Policy): void {
  if (policy.mode !== "live") {
    throw new ExecutionError(
      `Policy mode is "${policy.mode}". Set "mode": "live" in the config to allow execution. ` +
        `Nothing has been sent.`,
    );
  }
  if (process.env.CRUCIBLE_LIVE !== "1") {
    throw new ExecutionError(
      `The policy allows live execution but CRUCIBLE_LIVE is not set to 1 in this shell. ` +
        `Both switches have to agree before real money moves. Nothing has been sent.`,
    );
  }
}

/** Execute the exchange leg. */
async function executeBinance(opts: ExecuteOptions): Promise<ConfirmedFill[]> {
  const { plan, snapshot } = opts;
  if (!opts.binance) {
    throw new ExecutionError(
      "The plan routes to Binance, but no exchange credentials were supplied. " +
        "Set BINANCE_API_KEY and BINANCE_API_SECRET, and choose a base URL.",
    );
  }

  const client = new BinanceRest({
    baseUrl: opts.binance.baseUrl,
    credentials: opts.binance.credentials,
  });
  await client.syncClock();

  // Children when the plan is sliced, otherwise the whole order as one.
  const children =
    plan.slices.length > 0
      ? plan.slices
      : [{ index: 0, baseQty: plan.baseQty, offsetMs: 0 }];

  const fills: ConfirmedFill[] = [];
  const started = Date.now();

  for (const child of children) {
    const wait = started + child.offsetMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    const qty = roundToStep(child.baseQty, snapshot.filters.stepSize);
    if (qty <= 0) continue;

    const params = {
      symbol: snapshot.symbol,
      side: plan.intent.side,
      type: "MARKET" as const,
      quantity: qty,
      // Ties the exchange's own record back to the plan that authorised it.
      newClientOrderId: `cru-${plan.id}-${child.index}`.slice(0, 36),
    };

    // Binance validates against its own filters first. Cheaper to be refused
    // here than to have an order rejected after it has been counted.
    await client.testOrder(params);

    const placed = await client.newOrder(params);
    const settled = await client.awaitTerminal(snapshot.symbol, placed.orderId);
    const trades = await client.myTrades(snapshot.symbol, placed.orderId);
    fills.push(toConfirmedFill(settled, trades, snapshot.filters));
  }

  return fills;
}

/** Execute the on-chain leg through the wallet. */
async function executeOnchain(opts: ExecuteOptions): Promise<ConfirmedFill[]> {
  const { plan, snapshot } = opts;

  const session = await walletStatus();
  if (!session.connected) {
    throw new ExecutionError(
      "The plan routes on-chain, but no wallet session exists. Sign in with: baw auth signin --json, " +
        "confirm in the Binance app, then: baw auth verify --qrCodeId <id> --json",
    );
  }

  // The wallet's daily limit is enforced on its side regardless; checking it
  // first turns a refusal mid-execution into a refusal before anything is sent.
  const limits = await walletLimits();
  const notional = plan.quoteQty;
  if (limits.quotaLeftUsd < notional) {
    throw new ExecutionError(
      `This order is $${notional.toFixed(2)} but the wallet has only $${limits.quotaLeftUsd.toFixed(2)} ` +
        `of its $${limits.dailyLimitUsd.toFixed(2)} daily limit left. Raise the limit in the Binance app, or trade smaller.`,
    );
  }

  const base = TOKENS[snapshot.filters.baseAsset.toUpperCase()];
  const quote = TOKENS[snapshot.filters.quoteAsset.toUpperCase()];
  if (!base || !quote) {
    throw new ExecutionError(
      `No BSC contract on file for ${snapshot.filters.baseAsset}/${snapshot.filters.quoteAsset}, so the on-chain leg cannot be built.`,
    );
  }

  const buying = plan.intent.side === "BUY";
  // Native BNB is addressed by its sentinel rather than the wrapped contract
  // when it is the token being spent; the wallet wraps it as part of the swap.
  const fromToken = buying ? quote.address : base.symbol === "WBNB" ? NATIVE_BNB : base.address;
  const toToken = buying ? (base.symbol === "WBNB" ? NATIVE_BNB : base.address) : quote.address;
  const fromTokenQty = buying ? plan.quoteQty : plan.baseQty;

  const order = await executeSwap({
    fromToken,
    toToken,
    fromTokenQty: Number(fromTokenQty.toFixed(8)),
    slippage: "auto",
    mevProtection: true,
  });

  const filledBase = buying ? order.toTokenQty : order.fromTokenQty;
  const filledQuote = buying ? order.fromTokenQty : order.toTokenQty;

  return [
    {
      venue: "ONCHAIN",
      status: order.status === "FINISHED" ? "FILLED" : "FAILED",
      filledBaseQty: filledBase,
      filledQuoteQty: filledQuote,
      avgPrice: filledBase > 0 ? filledQuote / filledBase : 0,
      // Gas is paid in the chain's native asset, separately from the swap.
      feeAsset: "BNB",
      feeAmount: 0,
      isMaker: false,
      reference: order.txHash ?? order.orderId,
      confirmedBy: order.txHash
        ? `baw market-order list, terminal status ${order.status}, tx ${order.txHash}`
        : `baw market-order list, terminal status ${order.status} with no transaction hash`,
    },
  ];
}

/**
 * Build the receipt.
 *
 * The realised cost is measured against the mid the plan was built on, so it is
 * directly comparable with the prediction. `errorBps` is the difference, and it
 * is the number that says whether the cost model is any good — which is why it
 * is computed on every execution rather than only when it flatters us.
 */
export function buildReceipt(
  plan: Plan,
  snapshot: Snapshot,
  fills: ConfirmedFill[],
  completedAt = Date.now(),
): Receipt {
  const filledBase = fills.reduce((a, f) => a + f.filledBaseQty, 0);
  const filledQuote = fills.reduce((a, f) => a + f.filledQuoteQty, 0);
  const direction = plan.intent.side === "BUY" ? 1 : -1;

  const avgPrice = filledBase > 0 ? filledQuote / filledBase : 0;
  const realisedBps =
    filledBase > 0 ? ((avgPrice - snapshot.mid) / snapshot.mid) * 10_000 * direction : 0;

  const alternative = plan.alternatives.find((a) => !a.unavailable) ?? null;

  return {
    planId: plan.id,
    fingerprint: plan.fingerprint,
    intent: plan.intent,
    predicted: plan.chosen,
    alternative,
    fills,
    realisedBps,
    realisedUsd: (realisedBps / 10_000) * filledQuote,
    errorBps: realisedBps - plan.chosen.totalBps,
    savingBps: alternative ? alternative.totalBps - realisedBps : 0,
    savingUsd: alternative ? ((alternative.totalBps - realisedBps) / 10_000) * filledQuote : 0,
    completedAt,
  };
}

/**
 * Execute a plan and return its receipt.
 *
 * Everything is recorded: the attempt, the outcome, and any refusal. A ledger
 * that only holds successes is a marketing document.
 */
export async function execute(opts: ExecuteOptions): Promise<Receipt> {
  const { plan, snapshot, policy } = opts;
  const ledger = opts.ledger ?? new Ledger();
  const now = opts.now ?? Date.now();

  const record = (kind: string, payload: Record<string, unknown>) => {
    try {
      ledger.append(kind, payload);
    } catch {
      // A ledger that cannot be written must not swallow the execution result,
      // but it also must not be the reason a real fill goes unreported.
    }
  };

  try {
    assertExecutable(plan, now);
    assertLive(policy);
  } catch (err) {
    record("execution.refused", {
      planId: plan.id,
      fingerprint: plan.fingerprint,
      reason: (err as Error).message,
    });
    throw err;
  }

  record("execution.started", {
    planId: plan.id,
    fingerprint: plan.fingerprint,
    snapshotHash: snapshot.hash,
    venue: plan.chosen.venue,
    style: plan.chosen.style,
    baseQty: plan.baseQty,
    predictedBps: plan.chosen.totalBps,
  });

  let fills: ConfirmedFill[];
  try {
    fills =
      plan.chosen.venue === "ONCHAIN" ? await executeOnchain(opts) : await executeBinance(opts);
  } catch (err) {
    const message =
      err instanceof BinanceApiError || err instanceof WalletError || err instanceof RouteError
        ? err.message
        : `Unexpected failure: ${(err as Error).message}`;
    record("execution.failed", { planId: plan.id, fingerprint: plan.fingerprint, reason: message });
    throw new ExecutionError(message);
  }

  const receipt = buildReceipt(plan, snapshot, fills, Date.now());
  record("execution.completed", {
    planId: plan.id,
    fingerprint: plan.fingerprint,
    fills: receipt.fills,
    predictedBps: receipt.predicted.totalBps,
    realisedBps: receipt.realisedBps,
    errorBps: receipt.errorBps,
    savingUsd: receipt.savingUsd,
  });
  return receipt;
}
