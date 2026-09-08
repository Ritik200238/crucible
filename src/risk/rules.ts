/**
 * The rule set.
 *
 * Every rule is a pure function of (order, context). No I/O, no clock reads, no
 * hidden state - the clock and the account both arrive in the context. That is
 * what makes the engine testable and what makes an audit log trustworthy: given
 * the same inputs, a decision is always reproducible.
 */

import type {
  NoTradeWindow,
  OrderBook,
  Policy,
  ProposedOrder,
  Rule,
  RuleResult,
  Side,
  WalletQuote,
} from "../types.ts";

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${n.toFixed(1)}%`;
const bps = (n: number) => `${n.toFixed(1)} bps`;
const ms = (n: number) => `${Math.round(n).toLocaleString("en-US")} ms`;
const price = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 8 });

/**
 * Does this order shrink exposure rather than grow it?
 *
 * This matters more than it first appears. A risk limit that blocks the order
 * closing a losing position is worse than no limit at all - it traps the user in
 * exactly the trade they wanted out of. Rules that cap *new* risk therefore skip
 * risk-reducing orders, and say so in the audit log.
 */
export function reducesRisk(order: ProposedOrder): boolean {
  if (order.reduceOnly) return true;
  // On spot you can only sell what you hold, so a sell always reduces exposure.
  if (order.market === "SPOT" && order.side === "SELL") return true;
  return false;
}

const skip = (rule: string, why: string): RuleResult => ({
  rule,
  verdict: "ALLOW",
  message: why,
});

const pass = (rule: string, message: string, detail?: Record<string, unknown>): RuleResult => ({
  rule,
  verdict: "ALLOW",
  message,
  detail,
});

const block = (rule: string, message: string, detail?: Record<string, unknown>): RuleResult => ({
  rule,
  verdict: "BLOCK",
  message,
  detail,
});

/** Only trade the account types you meant to trade. */
export const allowedMarkets: Rule = {
  name: "allowed_markets",
  purpose: "Keeps the agent out of account types you did not mean to trade.",
  isConfigured: (p: Policy) => (p.allowedMarkets?.length ?? 0) > 0,
  evaluate(order, ctx) {
    const allowed = ctx.policy.allowedMarkets;
    if (!allowed || allowed.length === 0) return null;
    if (allowed.includes(order.market)) {
      return pass(this.name, `${order.market} is an allowed market.`);
    }
    return block(
      this.name,
      `${order.market} is not in your allowed markets (${allowed.join(", ")}).`,
      { requested: order.market, allowed },
    );
  },
};

/** Keep the agent inside a known universe of symbols. */
export const symbolPermitted: Rule = {
  name: "symbol_permitted",
  purpose: "Restricts trading to a known universe of symbols.",
  isConfigured: (p: Policy) =>
    (p.symbolAllowlist?.length ?? 0) > 0 || (p.symbolDenylist?.length ?? 0) > 0,
  evaluate(order, ctx) {
    const { symbolAllowlist, symbolDenylist } = ctx.policy;
    const symbol = order.symbol.toUpperCase();

    if (symbolDenylist?.some((s) => s.toUpperCase() === symbol)) {
      return block(this.name, `${symbol} is on your denylist.`, { symbol });
    }
    if (symbolAllowlist && symbolAllowlist.length > 0) {
      const ok = symbolAllowlist.some((s) => s.toUpperCase() === symbol);
      return ok
        ? pass(this.name, `${symbol} is on your allowlist.`, { symbol })
        : block(
            this.name,
            `${symbol} is not on your allowlist (${symbolAllowlist.join(", ")}).`,
            { symbol, allowlist: symbolAllowlist },
          );
    }
    if (!symbolDenylist || symbolDenylist.length === 0) return null;
    return pass(this.name, `${symbol} is not denied.`, { symbol });
  },
};

/** Cap the size of any single order. The bluntest and most useful rule there is. */
export const maxOrderNotional: Rule = {
  name: "max_order_notional",
  purpose: "Caps how large any single order can be.",
  isConfigured: (p: Policy) => p.maxOrderNotionalUsd !== undefined,
  evaluate(order, ctx) {
    const cap = ctx.policy.maxOrderNotionalUsd;
    if (cap === undefined) return null;

    const notional = orderNotionalUsd(order, ctx.markPrice);
    if (notional <= cap) {
      return pass(this.name, `${usd(notional)} is within your ${usd(cap)} per-order cap.`, {
        notionalUsd: notional,
        capUsd: cap,
      });
    }
    return block(
      this.name,
      `Order is ${usd(notional)}, which exceeds your ${usd(cap)} per-order cap by ${usd(notional - cap)}.`,
      { notionalUsd: notional, capUsd: cap, overageUsd: notional - cap },
    );
  },
};

/** Stop any one symbol from quietly becoming the whole book. */
export const maxPositionConcentration: Rule = {
  name: "max_position_concentration",
  purpose: "Stops one symbol from quietly becoming the entire book.",
  isConfigured: (p: Policy) => p.maxPositionPctOfEquity !== undefined,
  evaluate(order, ctx) {
    const capPct = ctx.policy.maxPositionPctOfEquity;
    if (capPct === undefined) return null;
    if (reducesRisk(order)) {
      return skip(this.name, "Skipped: this order reduces exposure.");
    }
    if (ctx.account.equityUsd <= 0) {
      return block(this.name, "Cannot size a position against zero equity.", {
        equityUsd: ctx.account.equityUsd,
      });
    }

    const existing =
      ctx.account.positions.find(
        (p) => p.symbol.toUpperCase() === order.symbol.toUpperCase(),
      )?.notionalUsd ?? 0;
    const added = orderNotionalUsd(order, ctx.markPrice);
    const resulting = existing + added;
    const resultingPct = (resulting / ctx.account.equityUsd) * 100;

    if (resultingPct <= capPct) {
      return pass(
        this.name,
        `${order.symbol} would be ${pct(resultingPct)} of equity, within your ${pct(capPct)} cap.`,
        { existingUsd: existing, addedUsd: added, resultingPct, capPct },
      );
    }
    return block(
      this.name,
      `${order.symbol} would become ${pct(resultingPct)} of equity, over your ${pct(capPct)} cap. ` +
        `You already hold ${usd(existing)} and this adds ${usd(added)}.`,
      { existingUsd: existing, addedUsd: added, resultingPct, capPct },
    );
  },
};

/** Leverage is where accounts die fastest, so it gets its own rule. */
export const maxLeverage: Rule = {
  name: "max_leverage",
  purpose: "Caps futures leverage.",
  isConfigured: (p: Policy) => p.maxLeverage !== undefined,
  evaluate(order, ctx) {
    const cap = ctx.policy.maxLeverage;
    if (cap === undefined) return null;
    if (order.leverage === undefined) return null;

    if (order.leverage <= cap) {
      return pass(this.name, `${order.leverage}x is within your ${cap}x cap.`, {
        requested: order.leverage,
        capX: cap,
      });
    }
    return block(
      this.name,
      `Requested ${order.leverage}x leverage, your cap is ${cap}x.`,
      { requested: order.leverage, capX: cap },
    );
  },
};

/**
 * The circuit breaker. Once the day is bad enough, stop opening new risk.
 * Risk-reducing orders stay permitted, deliberately - you must always be able
 * to get out.
 */
export const dailyLossLimit: Rule = {
  name: "daily_loss_limit",
  purpose: "Circuit breaker: halts new risk once the day is bad enough.",
  isConfigured: (p: Policy) => p.dailyLossLimitPct !== undefined,
  evaluate(order, ctx) {
    const limitPct = ctx.policy.dailyLossLimitPct;
    if (limitPct === undefined) return null;
    if (reducesRisk(order)) {
      return skip(this.name, "Skipped: closing orders are always permitted.");
    }
    if (ctx.account.equityUsd <= 0) return null;

    const pnl = ctx.state.realisedPnlTodayUsd;
    const lossPct = pnl < 0 ? (Math.abs(pnl) / ctx.account.equityUsd) * 100 : 0;

    if (lossPct < limitPct) {
      const headroom = limitPct - lossPct;
      return pass(
        this.name,
        `Down ${pct(lossPct)} today against a ${pct(limitPct)} limit. ${pct(headroom)} of headroom left.`,
        { realisedPnlUsd: pnl, lossPct, limitPct },
      );
    }
    return block(
      this.name,
      `Trading halted for today. You are down ${pct(lossPct)}, at or past your ${pct(limitPct)} daily loss limit. ` +
        `Closing orders still go through; new risk does not.`,
      { realisedPnlUsd: pnl, lossPct, limitPct },
    );
  },
};

/** Caps total churn, which caps fees and caps how wrong a bad day can go. */
export const maxDailyNotional: Rule = {
  name: "max_daily_notional",
  purpose: "Caps total traded volume per day, which caps fees and damage.",
  isConfigured: (p: Policy) => p.maxDailyNotionalUsd !== undefined,
  evaluate(order, ctx) {
    const cap = ctx.policy.maxDailyNotionalUsd;
    if (cap === undefined) return null;

    const added = orderNotionalUsd(order, ctx.markPrice);
    const resulting = ctx.state.notionalTodayUsd + added;
    if (resulting <= cap) {
      return pass(
        this.name,
        `${usd(resulting)} of ${usd(cap)} daily volume used after this order.`,
        { usedUsd: ctx.state.notionalTodayUsd, addedUsd: added, capUsd: cap },
      );
    }
    return block(
      this.name,
      `This order would put you at ${usd(resulting)} traded today, over your ${usd(cap)} daily limit. ` +
        `Already traded ${usd(ctx.state.notionalTodayUsd)}.`,
      { usedUsd: ctx.state.notionalTodayUsd, addedUsd: added, capUsd: cap },
    );
  },
};

/** The anti-tilt rule. After a loss, wait before opening the next position. */
export const cooldownAfterLoss: Rule = {
  name: "cooldown_after_loss",
  purpose: "Blocks new entries for a while after a loss. Anti-tilt.",
  isConfigured: (p: Policy) => p.cooldownAfterLossMinutes !== undefined,
  evaluate(order, ctx) {
    const minutes = ctx.policy.cooldownAfterLossMinutes;
    if (minutes === undefined || !ctx.state.lastLossAt) return null;
    if (reducesRisk(order)) {
      return skip(this.name, "Skipped: this order reduces exposure.");
    }

    const lastLoss = new Date(ctx.state.lastLossAt);
    const elapsedMin = (ctx.now.getTime() - lastLoss.getTime()) / 60_000;
    if (elapsedMin >= minutes) {
      return pass(this.name, `Last loss was ${Math.floor(elapsedMin)} min ago, cooldown cleared.`, {
        elapsedMin,
        requiredMin: minutes,
      });
    }
    const remaining = Math.ceil(minutes - elapsedMin);
    return block(
      this.name,
      `Cooling down after a loss ${Math.floor(elapsedMin)} min ago. ${remaining} min left of your ${minutes} min cooldown.`,
      { elapsedMin, requiredMin: minutes, remainingMin: remaining },
    );
  },
};

/** The runaway brake. A looping agent hits this before it hits your balance. */
export const maxOrdersPerHour: Rule = {
  name: "max_orders_per_hour",
  purpose: "Runaway brake: a looping agent hits this before it hits your balance.",
  isConfigured: (p: Policy) => p.maxOrdersPerHour !== undefined,
  evaluate(order, ctx) {
    const cap = ctx.policy.maxOrdersPerHour;
    if (cap === undefined) return null;

    const cutoff = ctx.now.getTime() - 3_600_000;
    const inWindow = ctx.state.recentOrderTimes.filter(
      (t) => new Date(t).getTime() >= cutoff,
    ).length;

    if (inWindow < cap) {
      return pass(this.name, `${inWindow} of ${cap} orders used in the last hour.`, {
        inWindow,
        capPerHour: cap,
      });
    }
    return block(
      this.name,
      `Rate limit hit: ${inWindow} orders in the last hour, your cap is ${cap}. ` +
        `If this was not deliberate, your agent may be looping.`,
      { inWindow, capPerHour: cap },
    );
  },
};

function minutesUtc(d: Date): number {
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function parseHhMm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** True when `now` falls inside the window, handling windows that cross midnight. */
export function inWindow(now: Date, w: NoTradeWindow): boolean {
  const start = parseHhMm(w.start);
  const end = parseHhMm(w.end);
  if (start === null || end === null) return false;
  const t = minutesUtc(now);
  return start <= end ? t >= start && t < end : t >= start || t < end;
}

/** Stay out of the hours you know you should stay out of. */
export const noTradeWindows: Rule = {
  name: "no_trade_window",
  purpose: "Keeps the agent out of hours you chose to sit out.",
  isConfigured: (p: Policy) => (p.noTradeWindowsUtc?.length ?? 0) > 0,
  evaluate(order, ctx) {
    const windows = ctx.policy.noTradeWindowsUtc;
    if (!windows || windows.length === 0) return null;
    if (reducesRisk(order)) {
      return skip(this.name, "Skipped: this order reduces exposure.");
    }

    const hit = windows.find((w) => inWindow(ctx.now, w));
    if (!hit) return pass(this.name, "Outside all no-trade windows.");

    const label = hit.label ? ` (${hit.label})` : "";
    return block(
      this.name,
      `Inside a no-trade window${label}: ${hit.start}-${hit.end} UTC.`,
      { window: hit, nowUtc: ctx.now.toISOString() },
    );
  },
};

/** Not a refusal - a request for a human. Large orders should be looked at. */
export const confirmAboveNotional: Rule = {
  name: "confirm_above_notional",
  purpose: "Escalates large orders to a human instead of refusing them.",
  isConfigured: (p: Policy) => p.confirmAboveNotionalUsd !== undefined,
  evaluate(order, ctx) {
    const threshold = ctx.policy.confirmAboveNotionalUsd;
    if (threshold === undefined) return null;

    const notional = orderNotionalUsd(order, ctx.markPrice);
    if (notional < threshold) {
      return pass(this.name, `${usd(notional)} is below your ${usd(threshold)} confirmation threshold.`, {
        notionalUsd: notional,
        thresholdUsd: threshold,
      });
    }
    return {
      rule: this.name,
      verdict: "CONFIRM",
      message: `${usd(notional)} is at or above your ${usd(threshold)} threshold. A human needs to approve this one.`,
      detail: { notionalUsd: notional, thresholdUsd: threshold },
    };
  },
};

/**
 * USD value of an order.
 *
 * quoteOrderQty is already denominated in the quote asset, so it is taken at
 * face value; quantity is converted at the mark price. This assumes a USD-pegged
 * quote asset, which holds for the USDT and USDC pairs this product targets. Pairs
 * quoted in BTC or BNB would need a second conversion hop, and are not yet
 * supported - `assertSupportedQuote` in engine.ts refuses them rather than
 * silently mispricing the risk.
 */
export function orderNotionalUsd(order: ProposedOrder, markPrice: number): number {
  if (order.quoteOrderQty !== undefined) return order.quoteOrderQty;
  if (order.quantity !== undefined) {
    const price = order.type === "LIMIT" && order.price !== undefined ? order.price : markPrice;
    return order.quantity * price;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Execution rules
//
// The rules above cap how much can be lost. The rules below cap how far a fill
// is allowed to drift from the one that was planned. They read the snapshot the
// routing decision was priced on, and every one of them returns null when the
// snapshot it needs is absent - an order evaluated without market state is not
// silently waved through, it is simply not the thing these rules judge.
// ---------------------------------------------------------------------------

/**
 * A snapshot with no usable mid cannot measure anything quoted in bps of mid.
 * Refusing beats reporting a drift of Infinity as if it were a number.
 */
function unusableMid(rule: string, mid: number): RuleResult {
  return block(
    rule,
    `The snapshot's mid price is ${price(mid)}, so this check cannot be computed. Take a fresh snapshot before sending.`,
    { mid },
  );
}

/** The cost of size itself: what the book charges beyond the touch. */
export const maxImpact: Rule = {
  name: "max_impact_bps",
  purpose: "Refuses orders whose walk through the book costs more than you agreed to pay.",
  isConfigured: (p: Policy) => p.maxImpactBps !== undefined,
  evaluate(order, ctx) {
    const cap = ctx.policy.maxImpactBps;
    if (cap === undefined) return null;
    if (reducesRisk(order)) {
      return skip(this.name, "Skipped: this order reduces exposure.");
    }
    if (ctx.impactBps === undefined) return null;

    if (ctx.impactBps <= cap) {
      return pass(
        this.name,
        `Walking the book for this size costs ${bps(ctx.impactBps)}, inside your ${bps(cap)} impact cap.`,
        { impactBps: ctx.impactBps, capBps: cap },
      );
    }
    return block(
      this.name,
      `Walking the book for this size costs ${bps(ctx.impactBps)}, over your ${bps(cap)} impact cap. ` +
        `Trade smaller or split it.`,
      { impactBps: ctx.impactBps, capBps: cap, overBps: ctx.impactBps - cap },
    );
  },
};

/** How far the price being sent has drifted from the price that was priced. */
export const maxSlippage: Rule = {
  name: "max_slippage_bps",
  purpose: "Refuses an order whose price has drifted from the mid the plan was built on.",
  isConfigured: (p: Policy) => p.maxSlippageBps !== undefined,
  evaluate(order, ctx) {
    const cap = ctx.policy.maxSlippageBps;
    if (cap === undefined) return null;
    const snapshot = ctx.snapshot;
    if (!snapshot || order.price === undefined) return null;
    if (!(snapshot.mid > 0)) return unusableMid(this.name, snapshot.mid);

    const driftBps = (Math.abs(order.price - snapshot.mid) / snapshot.mid) * 10_000;
    const detail = {
      orderPrice: order.price,
      mid: snapshot.mid,
      driftBps,
      capBps: cap,
    };

    if (driftBps <= cap) {
      return pass(
        this.name,
        `Order price ${price(order.price)} is ${bps(driftBps)} from the ${price(snapshot.mid)} mid, inside your ${bps(cap)} slippage cap.`,
        detail,
      );
    }
    return block(
      this.name,
      `Order price ${price(order.price)} is ${bps(driftBps)} from the ${price(snapshot.mid)} mid, over your ${bps(cap)} slippage cap. ` +
        `Re-price against a current snapshot before sending.`,
      detail,
    );
  },
};

/**
 * Resting notional within `windowBps` of mid on the side this order would hit.
 *
 * Both sides of the book arrive sorted away from mid, so the first level outside
 * the window ends the walk.
 */
export function restingNotionalUsd(
  book: OrderBook,
  side: Side,
  mid: number,
  windowBps: number,
): number {
  const levels = side === "BUY" ? book.asks : book.bids;
  const edge =
    side === "BUY" ? mid * (1 + windowBps / 10_000) : mid * (1 - windowBps / 10_000);

  let total = 0;
  for (const level of levels) {
    if (side === "BUY" ? level.price > edge : level.price < edge) break;
    total += level.price * level.qty;
  }
  return total;
}

/** A book too thin to absorb the order will fill it at a price nobody quoted. */
export const minDepthNotional: Rule = {
  name: "min_depth_notional",
  purpose: "Refuses to trade into a book too thin to absorb the order near mid.",
  isConfigured: (p: Policy) =>
    p.minDepthNotionalUsd !== undefined && p.depthWindowBps !== undefined,
  evaluate(order, ctx) {
    const floor = ctx.policy.minDepthNotionalUsd;
    const window = ctx.policy.depthWindowBps;
    if (floor === undefined || window === undefined) return null;
    const snapshot = ctx.snapshot;
    if (!snapshot) return null;
    if (!(snapshot.mid > 0)) return unusableMid(this.name, snapshot.mid);

    const resting = restingNotionalUsd(snapshot.book, order.side, snapshot.mid, window);
    const sideName = order.side === "BUY" ? "ask" : "bid";
    const detail = {
      side: sideName,
      restingUsd: resting,
      windowBps: window,
      floorUsd: floor,
    };

    if (resting >= floor) {
      return pass(
        this.name,
        `${usd(resting)} rests within ${bps(window)} of mid on the ${sideName} side, over your ${usd(floor)} depth floor.`,
        detail,
      );
    }
    return block(
      this.name,
      `Only ${usd(resting)} rests within ${bps(window)} of mid on the ${sideName} side, under your ${usd(floor)} depth floor. ` +
        `This order would walk past the quoted price.`,
      detail,
    );
  },
};

/** A decision priced on market state that has since moved must not execute. */
export const snapshotMaxAge: Rule = {
  name: "snapshot_max_age",
  purpose: "Refuses to act on market state old enough to have moved underneath the plan.",
  isConfigured: (p: Policy) => p.snapshotMaxAgeMs !== undefined,
  evaluate(_order, ctx) {
    const maxAge = ctx.policy.snapshotMaxAgeMs;
    if (maxAge === undefined || !ctx.snapshot) return null;

    const ageMs = ctx.now.getTime() - ctx.snapshot.takenAt;
    const detail = { ageMs, maxAgeMs: maxAge, takenAt: ctx.snapshot.takenAt };

    if (ageMs <= maxAge) {
      return pass(
        this.name,
        `Snapshot is ${ms(ageMs)} old, inside your ${ms(maxAge)} freshness limit.`,
        detail,
      );
    }
    return block(
      this.name,
      `Snapshot is ${ms(ageMs)} old, past your ${ms(maxAge)} freshness limit. ` +
        `The prices this decision was made on are no longer the prices you would get.`,
      detail,
    );
  },
};

/** Routing can pick a venue; this is where you say which ones it may pick. */
export const venueAllowlist: Rule = {
  name: "venue_allowlist",
  purpose: "Keeps fills on the venues you have approved for this account.",
  isConfigured: (p: Policy) => (p.venueAllowlist?.length ?? 0) > 0,
  evaluate(order, ctx) {
    const allowed = ctx.policy.venueAllowlist;
    if (!allowed || allowed.length === 0) return null;
    if (order.venue === undefined) return null;

    if (allowed.includes(order.venue)) {
      return pass(this.name, `${order.venue} is an allowed venue.`, {
        venue: order.venue,
        allowed,
      });
    }
    return block(
      this.name,
      `This order routes to ${order.venue}, which is not in your venue allowlist (${allowed.join(", ")}).`,
      { venue: order.venue, allowed },
    );
  },
};

/**
 * The wallet reports the swap it would actually send, so the side of the order
 * decides which way up its ratio has to go to become quote per base - the unit
 * the pool quote is already in.
 */
function walletPriceQuotePerBase(quote: WalletQuote, side: Side): number | null {
  if (!(quote.amountIn > 0) || !(quote.amountOut > 0)) return null;
  return side === "BUY" ? quote.amountIn / quote.amountOut : quote.amountOut / quote.amountIn;
}

/** Two independent sources disagreeing means one is wrong, and neither says which. */
export const quoteDisagreement: Rule = {
  name: "quote_disagreement",
  purpose: "Refuses to execute when the two independent on-chain price sources contradict each other.",
  isConfigured: (p: Policy) => p.maxQuoteDisagreementBps !== undefined,
  evaluate(order, ctx) {
    const cap = ctx.policy.maxQuoteDisagreementBps;
    if (cap === undefined) return null;
    const onchain = ctx.snapshot?.onchain;
    if (!onchain?.best || !onchain.walletQuote) return null;

    const poolPrice = onchain.best.price;
    const walletPrice = walletPriceQuotePerBase(onchain.walletQuote, order.side);
    if (walletPrice === null || !(poolPrice > 0)) return null;

    // Neither quote is the reference - if one were known good there would be
    // nothing to check - so the gap is measured against their midpoint.
    const gapBps = (Math.abs(poolPrice - walletPrice) / ((poolPrice + walletPrice) / 2)) * 10_000;
    const detail = { poolPrice, walletPrice, gapBps, capBps: cap };

    if (gapBps <= cap) {
      return pass(
        this.name,
        `Pool and wallet quotes agree to ${bps(gapBps)}, inside your ${bps(cap)} disagreement limit.`,
        detail,
      );
    }
    return block(
      this.name,
      `The pool quote (${price(poolPrice)}) and the wallet quote (${price(walletPrice)}) differ by ${bps(gapBps)}, ` +
        `over your ${bps(cap)} disagreement limit. One of them is wrong and neither says which.`,
      detail,
    );
  },
};

/** Evaluation order is the order these appear in a report, so it is deliberate. */
export const ALL_RULES: Rule[] = [
  allowedMarkets,
  symbolPermitted,
  maxLeverage,
  maxOrderNotional,
  maxPositionConcentration,
  dailyLossLimit,
  maxDailyNotional,
  cooldownAfterLoss,
  maxOrdersPerHour,
  noTradeWindows,
  confirmAboveNotional,
  maxImpact,
  maxSlippage,
  minDepthNotional,
  snapshotMaxAge,
  venueAllowlist,
  quoteDisagreement,
];
