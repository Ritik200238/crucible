/**
 * Core domain types for Guardrail.
 *
 * The shape here is deliberately narrow: an agent proposes an order, Guardrail
 * evaluates it against a policy, and returns a decision. Nothing reaches Binance
 * until the decision says it may.
 */

export type Side = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT";
export type Market = "SPOT" | "MARGIN" | "USDM_FUTURES" | "COINM_FUTURES";

/** An order an agent wants to place. Not yet sent anywhere. */
export interface ProposedOrder {
  symbol: string;
  side: Side;
  type: OrderType;
  market: Market;
  /** Amount in the base asset, e.g. 0.5 BTC. Mutually exclusive with quoteOrderQty. */
  quantity?: number;
  /** Amount in the quote asset, e.g. 100 USDT. Mutually exclusive with quantity. */
  quoteOrderQty?: number;
  /** Required for LIMIT orders. */
  price?: number;
  /** Futures only. Absent means the account default applies. */
  leverage?: number;
  /** Futures only. A reduce-only order can shrink a position but never grow one. */
  reduceOnly?: boolean;
}

/** What the account looks like at the moment of evaluation. */
export interface AccountSnapshot {
  equityUsd: number;
  positions: Position[];
  /** Realised PnL since 00:00 UTC today. Negative means down. */
  realisedPnlTodayUsd: number;
  /** Where these numbers came from, so a decision can be audited honestly. */
  source: "live" | "simulated";
}

export interface Position {
  symbol: string;
  notionalUsd: number;
}

/**
 * ALLOW  - passes every rule, may be sent
 * CONFIRM - passes, but a human must approve first
 * BLOCK  - at least one rule refuses it; it will not be sent
 */
export type Verdict = "ALLOW" | "CONFIRM" | "BLOCK";

export interface RuleResult {
  rule: string;
  verdict: Verdict;
  /** Human-readable, and written to be read aloud in a terminal. */
  message: string;
  /** The numbers behind the message, for the audit log. */
  detail?: Record<string, unknown>;
}

export interface Decision {
  verdict: Verdict;
  order: ProposedOrder;
  /** Best-effort USD value of the order at evaluation time. */
  notionalUsd: number;
  markPrice: number;
  results: RuleResult[];
  blockedBy: string[];
  confirmRequiredBy: string[];
  timestamp: string;
}

/** No-trade window, expressed in UTC "HH:MM" and inclusive of the start minute. */
export interface NoTradeWindow {
  start: string;
  end: string;
  label?: string;
}

/**
 * The user's rules. Every field is optional: an absent rule is simply not
 * enforced, which keeps the config honest about what is actually being checked.
 */
export interface Policy {
  version: number;
  /**
   * dry-run: decisions are made and logged, but no order is ever transmitted.
   * live:    ALLOW and confirmed CONFIRM orders are sent to Binance.
   */
  mode: "dry-run" | "live";
  maxOrderNotionalUsd?: number;
  maxDailyNotionalUsd?: number;
  maxPositionPctOfEquity?: number;
  maxLeverage?: number;
  /** Halt all new risk once realised losses today exceed this share of equity. */
  dailyLossLimitPct?: number;
  symbolAllowlist?: string[];
  symbolDenylist?: string[];
  /** Blocks new entries for N minutes after a realised loss. Stops revenge trading. */
  cooldownAfterLossMinutes?: number;
  /** Runaway-agent brake. */
  maxOrdersPerHour?: number;
  /** Orders at or above this notional need a human yes, even when every rule passes. */
  confirmAboveNotionalUsd?: number;
  noTradeWindowsUtc?: NoTradeWindow[];
  allowedMarkets?: Market[];
}

/** Rolling state Guardrail keeps so that time-based rules mean something. */
export interface GuardrailState {
  /** UTC date key, YYYY-MM-DD. Resets the daily counters when it rolls over. */
  day: string;
  notionalTodayUsd: number;
  ordersToday: number;
  /** ISO timestamps of orders sent, newest last. Used for the hourly rate limit. */
  recentOrderTimes: string[];
  /** ISO timestamp of the most recent realised loss, or null. */
  lastLossAt: string | null;
  realisedPnlTodayUsd: number;
}

export interface EvaluationContext {
  policy: Policy;
  account: AccountSnapshot;
  state: GuardrailState;
  markPrice: number;
  now: Date;
}

/** A rule is a pure function. That makes the whole engine trivially testable. */
export interface Rule {
  name: string;
  /** One line describing what this rule protects against. Shown by `guardrail policy`. */
  purpose: string;
  /**
   * Whether the user has configured this rule at all.
   *
   * Kept separate from `evaluate` because the two answer different questions.
   * `evaluate` returns null when a rule does not apply to *this order* - a
   * leverage cap is configured but silent on a spot trade. Only this predicate
   * can honestly say whether a limit is switched on, and reporting "off" for a
   * limit that is actually armed would be the worst kind of wrong for a safety
   * tool.
   */
  isConfigured(policy: Policy): boolean;
  /** Returns null when the rule does not apply to this particular order. */
  evaluate(order: ProposedOrder, ctx: EvaluationContext): RuleResult | null;
}
