/**
 * Rolling risk state, derived from the ledger.
 *
 * Four of the rules are cumulative: they care about what has already happened
 * today, not just about the order in front of them. Feeding them a counter that
 * starts at zero on every call makes them inert — the policy listing says they
 * are active while nothing can ever trigger them, and an order too large to pass
 * the per-order cap simply arrives eighty times instead of once.
 *
 * The counters are rebuilt from the ledger rather than kept in a file of their
 * own. A separate mutable counter can be reset by deleting it, or by restarting
 * the process, which is the same failure wearing different clothes. The ledger
 * is hash-chained and signed, so moving a number here means forging the chain.
 */

import type { LedgerRecord } from "../ledger/chain.ts";
import type { ConfirmedFill, RollingState, Side } from "../types.ts";

/**
 * Which records move money.
 *
 * A refusal moved nothing. A completed execution moved what its fills say. A
 * failed or unconfirmed one moved whatever confirmed before it went wrong, and
 * an unconfirmed one additionally has orders in flight whose outcome nobody
 * knows yet — those reserve their notional until a reconciliation says
 * otherwise. Not knowing is not the same as knowing it did not happen, and a
 * counter that frees budget on ignorance is one that can be made to forget.
 */
const COMPLETED = "execution.completed";
const FAILED = "execution.failed";
const UNCONFIRMED = "execution.unconfirmed";
const RECONCILED = "execution.reconciled";

interface MoneyPayload {
  planId?: string;
  fills?: ConfirmedFill[];
  confirmedFills?: ConfirmedFill[];
  submitted?: { venue: string; reference: string; baseQty: number; quoteQty: number }[];
  side?: Side;
  symbol?: string;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Running position in one symbol, for working out what a sale realised. */
interface Lot {
  qty: number;
  avgCost: number;
}

/**
 * Rebuild the counters from what actually executed.
 *
 * Realised profit is computed on an average-cost basis: buying adds to the
 * position and moves the average, and selling realises the difference between
 * the sale price and that average for the quantity sold. Anything still held is
 * not counted, because an unrealised loss is not a loss until it is taken and a
 * circuit breaker that halted on paper moves would halt on noise.
 */
export function deriveState(records: LedgerRecord[], now = Date.now()): RollingState {
  const today = utcDay(now);
  const hourAgo = now - 3_600_000;

  const lots = new Map<string, Lot>();
  let notionalTodayUsd = 0;
  let ordersToday = 0;
  let realisedPnlTodayUsd = 0;
  let lastLossAt: string | null = null;
  const recentOrderTimes: string[] = [];
  const unresolved: RollingState["unresolved"] = [];

  // A reconciliation closes the unconfirmed record it answers. Collected first
  // so an unconfirmed record can be judged against reconciliations that come
  // after it in the file.
  const reconciledPlans = new Set<string>();
  for (const record of records) {
    if (record.kind !== RECONCILED) continue;
    const planId = (record.payload as MoneyPayload)?.planId;
    if (planId) reconciledPlans.add(planId);
  }

  for (const record of records) {
    const at = Date.parse(record.timestamp);
    if (!Number.isFinite(at)) continue;
    const payload = (record.payload ?? {}) as MoneyPayload;

    let fills: ConfirmedFill[];
    if (record.kind === COMPLETED || record.kind === RECONCILED) {
      fills = Array.isArray(payload.fills) ? payload.fills : [];
    } else if (record.kind === FAILED || record.kind === UNCONFIRMED) {
      fills = Array.isArray(payload.confirmedFills) ? payload.confirmedFills : [];
    } else {
      continue;
    }

    // Orders sent and not read back hold their notional until a reconciliation
    // says what became of them. They count as orders too: a rate brake that
    // ignored in-flight orders would let a burst through on a slow network.
    if (record.kind === UNCONFIRMED && payload.planId && !reconciledPlans.has(payload.planId)) {
      for (const order of payload.submitted ?? []) {
        if (at >= Date.parse(`${today}T00:00:00.000Z`)) {
          notionalTodayUsd += order.quoteQty;
          ordersToday++;
        }
        if (at >= hourAgo) recentOrderTimes.push(new Date(at).toISOString());
        unresolved.push({
          planId: payload.planId,
          venue: order.venue,
          reference: order.reference,
          quoteQty: order.quoteQty,
          since: record.timestamp,
        });
      }
    }

    for (const fill of fills) {
      // A fill that never happened moves nothing. FAILED and PENDING are both
      // reported as fills by shape, so the status is what decides.
      if (fill.status !== "FILLED" && fill.status !== "PARTIAL") continue;
      if (!(fill.filledBaseQty > 0)) continue;

      const symbol = payload.symbol ?? "";
      const side = payload.side ?? "BUY";
      const price = fill.avgPrice;
      const qty = fill.filledBaseQty;

      if (at >= Date.parse(`${today}T00:00:00.000Z`)) {
        notionalTodayUsd += fill.filledQuoteQty;
        ordersToday++;
      }
      if (at >= hourAgo) recentOrderTimes.push(new Date(at).toISOString());

      const lot = lots.get(symbol) ?? { qty: 0, avgCost: price };
      if (side === "BUY") {
        const total = lot.qty + qty;
        lot.avgCost = total > 0 ? (lot.avgCost * lot.qty + price * qty) / total : price;
        lot.qty = total;
      } else {
        // Only the part that closes an existing position realises anything.
        // Selling more than is held is a short, and this router does not track
        // one, so the excess is ignored rather than booked as profit.
        const closing = Math.min(qty, lot.qty);
        if (closing > 0 && utcDay(at) === today) {
          const realised = (price - lot.avgCost) * closing;
          realisedPnlTodayUsd += realised;
          if (realised < 0) lastLossAt = new Date(at).toISOString();
        }
        lot.qty = Math.max(0, lot.qty - qty);
      }
      lots.set(symbol, lot);
    }
  }

  return {
    day: today,
    notionalTodayUsd,
    ordersToday,
    recentOrderTimes,
    lastLossAt,
    realisedPnlTodayUsd,
    unresolved,
  };
}

/** Counters with nothing behind them, for a first run with no ledger. */
export function emptyState(now = Date.now()): RollingState {
  return {
    day: utcDay(now),
    notionalTodayUsd: 0,
    ordersToday: 0,
    recentOrderTimes: [],
    lastLossAt: null,
    realisedPnlTodayUsd: 0,
    unresolved: [],
  };
}
