/**
 * The routing decision.
 *
 * Pure. Give it the same intent, snapshot and policy and it returns the same
 * plan, down to the fingerprint. Nothing here reads a clock or a network — the
 * time comes in with the snapshot — which is what makes a decision checkable by
 * someone who was not there when it was made.
 *
 * The plan it produces is single-use and short-lived. Market state goes stale in
 * seconds at these margins, so a plan is re-priced rather than replayed.
 */

import { createHash } from "node:crypto";
import { priceAllRoutes } from "../cost/model.ts";
import { roundToStep } from "../venues/binance.ts";
import { walkBook } from "../snapshot.ts";
import type {
  CostEstimate,
  Intent,
  Plan,
  Policy,
  Side,
  Slice,
  Snapshot,
} from "../types.ts";

export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteError";
  }
}

/** How long a plan stays executable. */
export const PLAN_TTL_MS = 60_000;

/** Hash of the policy fields that can change a routing decision. */
export function hashPolicy(policy: Policy): string {
  const h = createHash("sha256");
  h.update(
    JSON.stringify([
      policy.maxImpactBps ?? null,
      policy.maxSlippageBps ?? null,
      policy.minDepthNotionalUsd ?? null,
      policy.depthWindowBps ?? null,
      policy.snapshotMaxAgeMs ?? null,
      policy.venueAllowlist ?? null,
      policy.maxQuoteDisagreementBps ?? null,
      policy.maxOrderNotionalUsd ?? null,
    ]),
  );
  return h.digest("hex").slice(0, 16);
}

/**
 * Resolve the intent to a base quantity the exchange will actually accept.
 *
 * Rounded down onto the symbol's step size. Rounding up would produce an order
 * that is rejected outright, and leaving it unrounded produces one that is
 * rejected on precision — both after the routing work is already done.
 */
export function resolveQty(intent: Intent, snapshot: Snapshot): number {
  const hasBase = intent.baseQty !== undefined;
  const hasQuote = intent.quoteQty !== undefined;

  // Both set is a contradiction, not a preference to resolve quietly. Picking
  // one would leave the other in the plan and in the receipt, so the audit trail
  // would record a size that was never traded.
  if (hasBase && hasQuote) {
    throw new RouteError(
      `This intent carries both baseQty (${intent.baseQty}) and quoteQty (${intent.quoteQty}). ` +
        `They disagree about the size, so neither is used. Give exactly one.`,
    );
  }
  if (!hasBase && !hasQuote) {
    throw new RouteError("Specify exactly one of baseQty or quoteQty, greater than zero.");
  }

  const raw = hasBase ? intent.baseQty! : intent.quoteQty! / snapshot.mid;
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new RouteError("The size must be a finite number greater than zero.");
  }

  const qty = roundToStep(raw, snapshot.filters.stepSize);
  if (qty <= 0) {
    throw new RouteError(
      `A size of ${raw} rounds to zero against ${snapshot.symbol}'s step of ${snapshot.filters.stepSize}. ` +
        `The smallest tradeable amount is ${snapshot.filters.stepSize}.`,
    );
  }

  const notional = qty * snapshot.mid;
  if (snapshot.filters.minNotional > 0 && notional < snapshot.filters.minNotional) {
    throw new RouteError(
      `$${notional.toFixed(2)} is below ${snapshot.symbol}'s minimum order value of ` +
        `$${snapshot.filters.minNotional}. Increase the size.`,
    );
  }
  return qty;
}

/**
 * Split an order that would move the book too far.
 *
 * Impact scales worse than linearly with size, so N smaller orders spaced out
 * cost less than one large one. The gain is not free: the price can move against
 * you between children, and that risk grows with the window. So the split is
 * only proposed when the measured impact actually breaches the policy, never as
 * a default.
 */
export function planSlices(
  baseQty: number,
  impactBps: number,
  policy: Policy,
  stepSize: number,
): Slice[] {
  const cap = policy.maxImpactBps;
  if (cap === undefined || impactBps <= cap) return [];

  // Impact in a roughly linear book falls in proportion to child size, so the
  // number of children needed is the ratio of measured impact to the cap.
  const wanted = Math.ceil(impactBps / cap);
  const count = Math.min(10, Math.max(2, wanted));

  const per = roundToStep(baseQty / count, stepSize);
  if (per <= 0) return [];

  const slices: Slice[] = [];
  let allocated = 0;
  const spacingMs = 30_000;
  for (let i = 0; i < count; i++) {
    // The last child carries the rounding remainder so the total is exact.
    const qty = i === count - 1 ? Number((baseQty - allocated).toFixed(8)) : per;
    if (qty <= 0) break;
    allocated += qty;
    slices.push({ index: i, baseQty: qty, offsetMs: i * spacingMs });
  }
  return slices;
}

export interface RouteOptions {
  intent: Intent;
  snapshot: Snapshot;
  policy: Policy;
  /** Injected so a plan is reproducible in tests. Defaults to the snapshot time. */
  now?: number;
}

/**
 * Choose a venue and a style.
 *
 * Cheapest wins, with one deliberate exception: a route whose cost is entirely
 * modelled does not beat one that is measured unless it wins by more than the
 * modelling could plausibly be wrong by. Posting a maker order is the case that
 * matters — its advantage at a flat fee schedule is a fraction of a basis point,
 * and a fraction of a basis point is well inside the error of guessing whether
 * it fills at all.
 */
export function route(opts: RouteOptions): Plan {
  const { intent, snapshot, policy } = opts;
  const side: Side = intent.side;
  const now = opts.now ?? snapshot.takenAt;

  const baseQty = resolveQty(intent, snapshot);
  const quoteQty = baseQty * snapshot.mid;

  const allowed = policy.venueAllowlist;
  const priced = priceAllRoutes({ snapshot, side, baseQty }).map((r) =>
    allowed && !allowed.includes(r.venue)
      ? { ...r, unavailable: `${r.venue} is not in your venue allowlist.` }
      : r,
  );

  const usable = priced.filter((r) => !r.unavailable);
  if (usable.length === 0) {
    const why = priced.map((r) => `  ${r.venue}/${r.style}: ${r.unavailable}`).join("\n");
    throw new RouteError(`No route can fill this order.\n${why}`);
  }

  const ranked = [...usable].sort((a, b) => a.totalBps - b.totalBps);
  let chosen = ranked[0]!;

  // The estimated-route handicap. One basis point is the scale of the thing
  // being estimated, so that is the margin an estimate has to win by.
  const ESTIMATE_MARGIN_BPS = 1;
  if (chosen.hasEstimates) {
    const measured = ranked.find((r) => !r.hasEstimates);
    if (measured && measured.totalBps - chosen.totalBps < ESTIMATE_MARGIN_BPS) {
      chosen = measured;
    }
  }

  const alternatives = ranked.filter((r) => r !== chosen);
  const runnerUp = alternatives[0] ?? null;
  const savingBps = runnerUp ? runnerUp.totalBps - chosen.totalBps : 0;

  // Slicing only applies where impact is a measured book walk, which is the
  // Binance side. The pool's impact is already in its quote and cannot be
  // reduced by spacing orders out in the same block.
  const impactBps =
    chosen.venue === "BINANCE_SPOT"
      ? (chosen.components.find((c) => c.name === "book impact")?.bps ?? 0)
      : 0;
  const slices = planSlices(baseQty, impactBps, policy, snapshot.filters.stepSize);

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        intent.symbol.toUpperCase(),
        side,
        baseQty,
        snapshot.hash,
        hashPolicy(policy),
        chosen.venue,
        slices.length > 0 ? "SLICED" : chosen.style,
      ]),
    )
    .digest("hex")
    .slice(0, 16);

  return {
    id: fingerprint.slice(0, 12),
    fingerprint,
    intent,
    snapshotHash: snapshot.hash,
    createdAt: now,
    expiresAt: now + PLAN_TTL_MS,
    chosen: slices.length > 0 ? { ...chosen, style: "SLICED" } : chosen,
    alternatives,
    savingBps,
    savingUsd: (savingBps / 10_000) * quoteQty,
    baseQty,
    quoteQty,
    slices,
    rationale: explain(chosen, runnerUp, slices, savingBps),
  };
}

function explain(
  chosen: CostEstimate,
  runnerUp: CostEstimate | null,
  slices: Slice[],
  savingBps: number,
): string {
  const venue = chosen.venue === "ONCHAIN" ? "on-chain" : "Binance spot";
  const parts: string[] = [];

  if (runnerUp) {
    const other = runnerUp.venue === "ONCHAIN" ? "on-chain" : "Binance spot";
    const otherStyle = runnerUp.venue === "BINANCE_SPOT" ? ` ${runnerUp.style.toLowerCase()}` : "";
    parts.push(
      savingBps > 0.01
        ? `${venue} at ${chosen.totalBps.toFixed(2)} bps beats ${other}${otherStyle} at ${runnerUp.totalBps.toFixed(2)} bps, a saving of ${savingBps.toFixed(2)} bps.`
        : `${venue} and ${other}${otherStyle} are within ${Math.abs(savingBps).toFixed(2)} bps of each other; ${venue} is taken on measured rather than modelled cost.`,
    );
  } else {
    parts.push(`${venue} at ${chosen.totalBps.toFixed(2)} bps is the only route available.`);
  }

  if (slices.length > 0) {
    parts.push(
      `Split into ${slices.length} children over ${Math.round((slices[slices.length - 1]!.offsetMs) / 1000)}s because a single order moves the book past your impact cap.`,
    );
  }
  if (chosen.hasEstimates) {
    parts.push("Some components of this route are modelled, not measured.");
  }
  return parts.join(" ");
}

/**
 * Refuse a plan whose market state has gone stale.
 *
 * Expiry only. Single use cannot be settled from the plan alone, because
 * nothing in it records whether it has already been spent — that check needs
 * the ledger and lives in `execute`.
 */
export function assertExecutable(plan: Plan, now = Date.now()): void {
  if (now > plan.expiresAt) {
    const ageSec = Math.round((now - plan.createdAt) / 1000);
    throw new RouteError(
      `Plan ${plan.id} expired ${Math.round((now - plan.expiresAt) / 1000)}s ago (created ${ageSec}s ago). ` +
        `Market state has moved; take a fresh quote rather than executing a stale plan.`,
    );
  }
}

/** Impact of this size against the live book, for the risk engine. */
export function measuredImpactBps(snapshot: Snapshot, side: Side, baseQty: number): number {
  const walk = walkBook(snapshot.book, side, baseQty);
  if (walk.exhausted || walk.filled <= 0) return Infinity;
  const touch = side === "BUY" ? snapshot.bestAsk : snapshot.bestBid;
  const direction = side === "BUY" ? 1 : -1;
  return ((walk.avgPrice - touch) / snapshot.mid) * 10_000 * direction;
}
