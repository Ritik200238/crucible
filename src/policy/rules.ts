/**
 * The rule set.
 *
 * Every rule is a pure function of (order, context). No I/O, no clock reads, no
 * hidden state - the clock and the account both arrive in the context. That is
 * what makes the engine testable and what makes an audit log trustworthy: given
 * the same inputs, a decision is always reproducible.
 */

import type {
  EvaluationContext,
  NoTradeWindow,
  Policy,
  ProposedOrder,
  Rule,
  RuleResult,
} from "../types.ts";

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${n.toFixed(1)}%`;

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
 * quote asset, which holds for the USDT and USDC pairs Guardrail targets. Pairs
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
];
