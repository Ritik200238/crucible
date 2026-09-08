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

/** Only completed executions move the counters. A refusal moved no money. */
const COMPLETED = "execution.completed";

interface CompletedPayload {
  fills?: ConfirmedFill[];
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

  for (const record of records) {
    if (record.kind !== COMPLETED) continue;

    const at = Date.parse(record.timestamp);
    if (!Number.isFinite(at)) continue;

    const payload = (record.payload ?? {}) as CompletedPayload;
    const fills = Array.isArray(payload.fills) ? payload.fills : [];

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
  };
}
