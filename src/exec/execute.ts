/**
 * Execution.
 *
 * Takes a plan and makes it real, on whichever venue the plan chose. Four rules
 * hold on both paths, and each of them exists because breaking it is how an
 * execution tool ends up reporting a trade that did not happen:
 *
 *   1. A plan is checked for expiry and for having already been spent before
 *      anything is sent. Stale market state is re-priced, never replayed, and a
 *      fingerprint executes at most once.
 *   2. Nothing is transmitted unless the policy says live and the environment
 *      agrees. Two switches, both held by a human.
 *   3. The response to the placing call is never treated as the outcome. The
 *      fill is read back from the venue on a separate call.
 *   4. Every attempt is written to the ledger, including the ones that failed
 *      and the ones that were refused.
 */

import { assertExecutable, RouteError } from "../decide/router.ts";
import { Ledger } from "../ledger/chain.ts";
import { NATIVE_BNB, TOKENS } from "../venues/onchain.ts";
import { fetchSymbolFilters, roundToStep } from "../venues/binance.ts";
import {
  BinanceApiError,
  BinanceRest,
  toConfirmedFill,
  type Credentials,
} from "./binance-rest.ts";
import {
  awaitSwap,
  getSwapOrder,
  submitSwap,
  walletLimits,
  walletStatus,
  WalletError,
  type SwapOrder,
} from "./wallet.ts";
import type { ConfirmedFill, Plan, Policy, Receipt, Side, Snapshot, Venue } from "../types.ts";

export class ExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionError";
  }
}

/**
 * An order left for the venue and its outcome could not be established.
 *
 * This is not a failure and must never be reported as one. A failure means
 * nothing was sent; this means something was, and the honest state is "unknown"
 * until the venue is asked again. It is a separate class so a caller can tell
 * the two apart without parsing a message, because the correct next action is
 * different: a failure may be retried, and an unconfirmed order must not be.
 */
export class UnconfirmedError extends ExecutionError {
  readonly planId: string;
  readonly submitted: SubmittedOrder[];
  constructor(message: string, planId: string, submitted: SubmittedOrder[]) {
    super(message);
    this.name = "UnconfirmedError";
    this.planId = planId;
    this.submitted = submitted;
  }
}

/** What was sent to a venue, recorded the moment it was accepted. */
export interface SubmittedOrder {
  venue: Venue;
  /** The venue's own identifier: an exchange order id, or a wallet swap order id. */
  reference: string;
  baseQty: number;
  /** Notional at the snapshot mid. Reserved against the caps until resolved. */
  quoteQty: number;
}

/**
 * How the venue legs report back while an execution is in flight.
 *
 * `submitted` fires the instant a venue accepts an order, before any attempt to
 * learn what became of it. `confirmed` fires once a fill has been read back.
 * Between the two, money may have moved; the outer path uses the gap to decide
 * whether a failure is a failure or an unknown.
 */
interface Progress {
  submitted(order: SubmittedOrder): void;
  confirmed(fill: ConfirmedFill): void;
}

export interface ExecuteOptions {
  plan: Plan;
  snapshot: Snapshot;
  policy: Policy;
  /**
   * Required to reach the exchange. Absent means the Binance leg cannot run.
   *
   * `fetchImpl` exists so the whole path — validate, place, confirm, receipt —
   * can be exercised against a simulated venue. Without it the only way to test
   * execution is to execute, and a pipeline whose sole proof is a live order is
   * a pipeline nobody dares run.
   */
  binance?: { baseUrl: string; credentials: Credentials; fetchImpl?: typeof fetch };
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

/**
 * Refuse a plan that has already been acted on.
 *
 * A fingerprint covers the intent, the market state and the policy, so the same
 * one arriving twice is the same authorisation being spent twice. Expiry alone
 * does not stop that: a plan can be replayed freely inside its own minute.
 *
 * The check reads the ledger rather than a set held in memory, because an
 * in-memory guard is cleared by a restart, and "restart the process" is not a
 * difficulty for anything that would want to replay an order.
 */
export function assertSpendable(plan: Plan, ledger: Ledger): void {
  let seen = false;
  try {
    seen = ledger
      .read()
      .some(
        (r) =>
          (r.kind === "execution.started" || r.kind === "execution.completed") &&
          (r.payload as { fingerprint?: string })?.fingerprint === plan.fingerprint,
      );
  } catch {
    // An unreadable ledger cannot prove the plan is fresh. It also cannot prove
    // it is spent, and refusing every order because the log is unreadable would
    // be its own failure, so this falls through and the attempt is recorded.
    return;
  }
  if (seen) {
    throw new ExecutionError(
      `Plan ${plan.id} has already been executed. A fingerprint authorises one order, and this one ` +
        `is on the record. Take a fresh quote rather than sending the same authorisation twice.`,
    );
  }
}

/** Execute the exchange leg. */
async function executeBinance(opts: ExecuteOptions, progress: Progress): Promise<ConfirmedFill[]> {
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
    ...(opts.binance.fetchImpl ? { fetchImpl: opts.binance.fetchImpl } : {}),
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
    // From here the order exists on the exchange whatever happens next. The
    // read-back can time out, the network can drop, the process can die; none
    // of those un-send it, so it is recorded as sent before any of them can.
    progress.submitted({
      venue: "BINANCE_SPOT",
      reference: String(placed.orderId),
      baseQty: qty,
      quoteQty: qty * snapshot.mid,
    });
    const settled = await client.awaitTerminal(snapshot.symbol, placed.orderId);
    const trades = await client.myTrades(snapshot.symbol, placed.orderId);
    const fill = toConfirmedFill(settled, trades, snapshot.filters);
    progress.confirmed(fill);
    fills.push(fill);
  }

  return fills;
}

/** Execute the on-chain leg through the wallet. */
async function executeOnchain(opts: ExecuteOptions, progress: Progress): Promise<ConfirmedFill[]> {
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

  const orderId = await submitSwap({
    fromToken,
    toToken,
    fromTokenQty: Number(fromTokenQty.toFixed(8)),
    slippage: "auto",
    mevProtection: true,
  });
  // The wallet has the swap and will broadcast it on its own schedule. Whether
  // this process is still around to see the result changes nothing on-chain.
  progress.submitted({
    venue: "ONCHAIN",
    reference: orderId,
    baseQty: plan.baseQty,
    quoteQty: plan.quoteQty,
  });

  const fill = swapToFill(await awaitSwap(orderId), buying);
  progress.confirmed(fill);
  return [fill];
}

/** Turn a terminal swap order into a fill, in the plan's own terms. */
function swapToFill(order: SwapOrder, buying: boolean): ConfirmedFill {
  const filledBase = buying ? order.toTokenQty : order.fromTokenQty;
  const filledQuote = buying ? order.fromTokenQty : order.toTokenQty;
  return {
    venue: "ONCHAIN",
    status: order.status === "FINISHED" ? "FILLED" : "FAILED",
    filledBaseQty: filledBase,
    filledQuoteQty: filledQuote,
    avgPrice: filledBase > 0 ? filledQuote / filledBase : 0,
    // The pool fee is taken inside the swap and is already reflected in the
    // amount received, so there is no separate commission to report. Gas is
    // paid in the chain's native asset and is not a commission either.
    fees: [],
    totalFeeInQuote: 0,
    isMaker: false,
    reference: order.txHash ?? order.orderId,
    confirmedBy: order.txHash
      ? `baw market-order list, terminal status ${order.status}, tx ${order.txHash}`
      : `baw market-order list, terminal status ${order.status} with no transaction hash`,
  };
}

/**
 * The realised cost of a set of fills against the mid they were priced from.
 *
 * Shared by the receipt and by reconciliation, so a fill that arrives late is
 * costed by exactly the arithmetic a fill that arrived on time would have been.
 */
export function realisedCost(
  fills: ConfirmedFill[],
  mid: number,
  side: Side,
): { grossBps: number; feeBps: number | null; bps: number | null; filledQuote: number; unpriceable: number } {
  const filledBase = fills.reduce((a, f) => a + f.filledBaseQty, 0);
  const filledQuote = fills.reduce((a, f) => a + f.filledQuoteQty, 0);
  const direction = side === "BUY" ? 1 : -1;

  const avgPrice = filledBase > 0 ? filledQuote / filledBase : 0;
  const grossBps = filledBase > 0 ? ((avgPrice - mid) / mid) * 10_000 * direction : 0;

  // Commission has to be added in, or the comparison is not one. The prediction
  // carries the taker fee as its largest component, so leaving it out of the
  // realised side understates the cost by about that fee on every fill.
  //
  // A fee charged in an asset this fill cannot price is not folded in silently.
  // The realised figure is reported as unavailable instead, because a number
  // that is quietly missing a component is worse than an absent one.
  const unpriceable = fills.filter((f) => f.totalFeeInQuote === null).length;
  const feeInQuote = fills.reduce((a, f) => a + (f.totalFeeInQuote ?? 0), 0);

  // Nothing filled is not the same as a fee that cannot be priced. An order
  // that traded nothing cost nothing, and reporting that as unavailable would
  // hide a clean fact behind a caveat meant for a different problem.
  const feeBps = filledQuote <= 0 ? 0 : unpriceable > 0 ? null : (feeInQuote / filledQuote) * 10_000;

  return {
    grossBps,
    feeBps,
    bps: feeBps === null ? null : grossBps + feeBps,
    filledQuote,
    unpriceable,
  };
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
  const cost = realisedCost(fills, snapshot.mid, plan.intent.side);
  const { grossBps: realisedGrossBps, feeBps: realisedFeeBps, bps: realisedBps, filledQuote } = cost;
  const alternative = plan.alternatives.find((a) => !a.unavailable) ?? null;

  const errorUnavailable =
    realisedBps === null
      ? `Commission on ${cost.unpriceable} fill(s) was charged in an asset that cannot be ` +
        `priced against ${snapshot.filters.quoteAsset} from this trade, so the realised cost ` +
        `cannot be completed and the comparison against the prediction is not made.`
      : undefined;

  return {
    planId: plan.id,
    fingerprint: plan.fingerprint,
    intent: plan.intent,
    predicted: plan.chosen,
    alternative,
    fills,
    realisedGrossBps,
    realisedFeeBps,
    realisedBps,
    realisedUsd: realisedBps === null ? null : (realisedBps / 10_000) * filledQuote,
    errorBps: realisedBps === null ? null : realisedBps - plan.chosen.totalBps,
    ...(errorUnavailable ? { errorUnavailable } : {}),
    savingBps: realisedBps === null || !alternative ? null : alternative.totalBps - realisedBps,
    savingUsd:
      realisedBps === null || !alternative
        ? null
        : ((alternative.totalBps - realisedBps) / 10_000) * filledQuote,
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
    assertSpendable(plan, ledger);
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

  // What has left for a venue, and what has been read back. The difference
  // between the two lists is the set of orders whose outcome is unknown.
  const submitted: SubmittedOrder[] = [];
  const confirmed: ConfirmedFill[] = [];
  const progress: Progress = {
    submitted: (order) => {
      submitted.push(order);
      record("execution.submitted", {
        planId: plan.id,
        fingerprint: plan.fingerprint,
        venue: order.venue,
        reference: order.reference,
        baseQty: order.baseQty,
        quoteQty: order.quoteQty,
      });
    },
    confirmed: (fill) => confirmed.push(fill),
  };

  let fills: ConfirmedFill[];
  try {
    fills =
      plan.chosen.venue === "ONCHAIN"
        ? await executeOnchain(opts, progress)
        : await executeBinance(opts, progress);
  } catch (err) {
    const message =
      err instanceof BinanceApiError || err instanceof WalletError || err instanceof RouteError
        ? err.message
        : `Unexpected failure: ${(err as Error).message}`;

    // Anything sent but not read back is unresolved. "Failed" is reserved for
    // the case where nothing reached a venue, because the two call for opposite
    // responses: a failure can be retried and an unresolved order must not be.
    const unresolved = submitted.filter(
      (s) => !confirmed.some((f) => f.reference === s.reference),
    );

    if (unresolved.length === 0) {
      record("execution.failed", {
        planId: plan.id,
        fingerprint: plan.fingerprint,
        reason: message,
        symbol: snapshot.symbol,
        side: plan.intent.side,
        // Fills that did confirm before the failure moved money and are
        // counted, even though the plan as a whole did not complete.
        confirmedFills: confirmed,
      });
      throw new ExecutionError(
        confirmed.length > 0
          ? `${confirmed.length} of ${submitted.length + 1} order(s) filled before the plan failed: ${message}`
          : message,
      );
    }

    record("execution.unconfirmed", {
      planId: plan.id,
      fingerprint: plan.fingerprint,
      symbol: snapshot.symbol,
      side: plan.intent.side,
      mid: snapshot.mid,
      predictedBps: plan.chosen.totalBps,
      submitted: unresolved,
      confirmedFills: confirmed,
      reason: message,
    });
    throw new UnconfirmedError(
      `Plan ${plan.id} sent ${unresolved.length} order(s) whose outcome could not be established: ${message} ` +
        `The order was not refused and it did not fail — it was sent, and the venue has not yet said what ` +
        `became of it. Its notional is held against your caps until it is resolved. Do not retry blind: ` +
        `run \`crucible reconcile --plan ${plan.id}\` to read it back from the venue.`,
      plan.id,
      unresolved,
    );
  }

  const receipt = buildReceipt(plan, snapshot, fills, Date.now());
  record("execution.completed", {
    planId: plan.id,
    fingerprint: plan.fingerprint,
    // The symbol and side are what let the cumulative rules rebuild a position
    // from this record later. Without them a sale cannot be matched to what it
    // closed, and realised profit is unattributable.
    symbol: snapshot.symbol,
    side: plan.intent.side,
    venue: plan.chosen.venue,
    fills: receipt.fills,
    predictedBps: receipt.predicted.totalBps,
    realisedBps: receipt.realisedBps,
    errorBps: receipt.errorBps,
    savingUsd: receipt.savingUsd,
  });
  return receipt;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface ReconcileOptions {
  planId: string;
  ledger?: Ledger;
  binance?: { baseUrl: string; credentials: Credentials; fetchImpl?: typeof fetch };
  /** The symbol's filters, for reading a fill back. Fetched from the exchange when absent. */
  filters?: Snapshot["filters"];
  /** How the on-chain side is read back. Defaults to the wallet CLI. */
  swapLookup?: (orderId: string) => Promise<SwapOrder>;
  /** How the symbol's filters are fetched when not supplied. */
  filtersLookup?: (symbol: string) => Promise<Snapshot["filters"]>;
}

export interface Reconciliation {
  planId: string;
  /** What each unresolved order turned out to be. */
  fills: ConfirmedFill[];
  outcome: "filled" | "partial" | "never_filled" | "still_unresolved";
  realisedBps: number | null;
  errorBps: number | null;
  /** References the venue still reports as open. Their hold stays in place. */
  stillOpen: string[];
}

interface UnconfirmedPayload {
  planId?: string;
  fingerprint?: string;
  symbol?: string;
  side?: Side;
  mid?: number;
  predictedBps?: number;
  submitted?: SubmittedOrder[];
  confirmedFills?: ConfirmedFill[];
}

/**
 * Ask the venue what became of an order this process lost track of.
 *
 * The record it closes is the one thing in the ledger that says "unknown". It
 * stays unknown — and its notional stays reserved against the caps — until this
 * has been run and the venue has answered. That is deliberate: a system that
 * freed the budget on a timeout is a system that can be made to forget an
 * order by making the network slow at the right moment.
 *
 * The answer is written as its own record rather than by editing the old one,
 * because the ledger is append-only and because "we did not know, and then we
 * found out" is a truer account than one that never admitted the gap.
 */
export async function reconcile(opts: ReconcileOptions): Promise<Reconciliation> {
  const ledger = opts.ledger ?? new Ledger();
  const records = ledger.read();

  const open = records.find(
    (r) =>
      r.kind === "execution.unconfirmed" &&
      (r.payload as UnconfirmedPayload)?.planId === opts.planId &&
      !records.some(
        (later) =>
          later.seq > r.seq &&
          later.kind === "execution.reconciled" &&
          (later.payload as { planId?: string })?.planId === opts.planId,
      ),
  );
  if (!open) {
    throw new ExecutionError(
      `Plan ${opts.planId} has no unresolved order on the record. Either it was never sent, it ` +
        `completed normally, or it has already been reconciled — check with: crucible verify`,
    );
  }

  const payload = open.payload as UnconfirmedPayload;
  const submitted = payload.submitted ?? [];
  const symbol = payload.symbol ?? "";
  const side: Side = payload.side ?? "BUY";
  const mid = payload.mid ?? 0;

  const fills: ConfirmedFill[] = [];
  const stillOpen: string[] = [];

  for (const order of submitted) {
    if (order.venue === "BINANCE_SPOT") {
      if (!opts.binance) {
        throw new ExecutionError(
          `Order ${order.reference} is on Binance, but no exchange credentials were supplied to read it back. ` +
            `Set BINANCE_API_KEY and BINANCE_API_SECRET and run the reconcile again.`,
        );
      }
      const client = new BinanceRest({
        baseUrl: opts.binance.baseUrl,
        credentials: opts.binance.credentials,
        ...(opts.binance.fetchImpl ? { fetchImpl: opts.binance.fetchImpl } : {}),
      });
      await client.syncClock();
      const current = await client.queryOrder(symbol, Number(order.reference));
      const terminal = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED", "EXPIRED_IN_MATCH"]);
      if (!terminal.has(current.status)) {
        stillOpen.push(order.reference);
        continue;
      }
      const filters =
        opts.filters ??
        (await (opts.filtersLookup ?? fetchSymbolFilters)(symbol));
      const trades = await client.myTrades(symbol, Number(order.reference));
      fills.push(toConfirmedFill(current, trades, filters));
    } else {
      const lookup = opts.swapLookup ?? ((id: string) => getSwapOrder(id));
      const swap = await lookup(order.reference);
      if (swap.status !== "FINISHED" && swap.status !== "FAILED") {
        stillOpen.push(order.reference);
        continue;
      }
      fills.push(swapToFill(swap, side === "BUY"));
    }
  }

  const traded = fills.filter((f) => f.status === "FILLED" || f.status === "PARTIAL");
  const cost = mid > 0 ? realisedCost(traded, mid, side) : null;
  const realisedBps = cost?.bps ?? null;
  const predicted = payload.predictedBps;

  let outcome: Reconciliation["outcome"];
  if (stillOpen.length > 0) outcome = "still_unresolved";
  else if (traded.length === 0) outcome = "never_filled";
  else if (traded.length === submitted.length && traded.every((f) => f.status === "FILLED")) outcome = "filled";
  else outcome = "partial";

  const result: Reconciliation = {
    planId: opts.planId,
    fills,
    outcome,
    realisedBps,
    errorBps: realisedBps !== null && typeof predicted === "number" ? realisedBps - predicted : null,
    stillOpen,
  };

  // Only a settled answer closes the hold. "Still open" is recorded so the
  // attempt is on the chain, but the unconfirmed record stays in force.
  if (outcome !== "still_unresolved") {
    ledger.append("execution.reconciled", {
      planId: opts.planId,
      fingerprint: payload.fingerprint,
      venue: submitted[0]?.venue,
      symbol,
      side,
      fills,
      outcome,
      predictedBps: predicted,
      realisedBps,
      errorBps: result.errorBps,
    });
  } else {
    ledger.append("execution.reconcile_attempted", {
      planId: opts.planId,
      stillOpen,
    });
  }

  return result;
}
