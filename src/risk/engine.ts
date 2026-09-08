/**
 * The evaluation engine.
 *
 * Runs every rule, collects the results, and reduces them to a single verdict.
 * The reduction is intentionally strict: one BLOCK blocks the order, no matter
 * how many rules passed. Safety rules that can be outvoted are not safety rules.
 */

import type {
  Decision,
  EvaluationContext,
  Policy,
  ProposedOrder,
  RuleResult,
} from "../types.ts";
import { ALL_RULES, orderNotionalUsd } from "./rules.ts";

export class InvalidOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOrderError";
  }
}

/** Quote assets that can be priced at 1:1 against USD. */
const USD_QUOTES = ["USDT", "USDC", "FDUSD", "TUSD", "BUSD", "USD"];

/**
 * Refuse pairs that cannot be priced correctly.
 *
 * A BTC-quoted pair would need a second conversion hop to reach USD. Rather than
 * guess and under-report the risk on every notional rule, the engine declines to
 * evaluate it at all. Refusing to answer beats answering wrongly when the answer
 * decides whether real money moves.
 */
export function assertSupportedQuote(symbol: string): void {
  const s = symbol.toUpperCase();
  if (!USD_QUOTES.some((q) => s.endsWith(q))) {
    throw new InvalidOrderError(
      `${symbol} is not quoted in a USD-pegged asset. Risk is priced in USD here, and ` +
        `will not evaluate a pair it cannot price directly (supported quotes: ${USD_QUOTES.join(", ")}).`,
    );
  }
}

/** Structural validation. Catches malformed agent output before any rule runs. */
export function validateOrder(order: ProposedOrder): void {
  if (!order.symbol || !/^[A-Z0-9]{4,20}$/i.test(order.symbol)) {
    throw new InvalidOrderError(`"${order.symbol}" is not a valid symbol.`);
  }
  assertSupportedQuote(order.symbol);

  const hasQty = order.quantity !== undefined;
  const hasQuote = order.quoteOrderQty !== undefined;
  if (hasQty === hasQuote) {
    throw new InvalidOrderError(
      "Specify exactly one of quantity (base asset) or quoteOrderQty (quote asset).",
    );
  }
  if (hasQty && !(order.quantity! > 0)) {
    throw new InvalidOrderError("quantity must be greater than zero.");
  }
  if (hasQuote && !(order.quoteOrderQty! > 0)) {
    throw new InvalidOrderError("quoteOrderQty must be greater than zero.");
  }
  if (order.type === "LIMIT" && !(order.price! > 0)) {
    throw new InvalidOrderError("A LIMIT order needs a price greater than zero.");
  }
  if (order.leverage !== undefined && !(order.leverage >= 1)) {
    throw new InvalidOrderError("leverage must be at least 1.");
  }
  const isFutures = order.market === "USDM_FUTURES" || order.market === "COINM_FUTURES";
  if (order.leverage !== undefined && !isFutures) {
    throw new InvalidOrderError(`Leverage does not apply to ${order.market} orders.`);
  }
  if (order.reduceOnly && !isFutures) {
    throw new InvalidOrderError(`reduceOnly does not apply to ${order.market} orders.`);
  }
}

/** Reduce many rule results to one verdict. Any BLOCK wins; CONFIRM beats ALLOW. */
export function reduceVerdict(results: RuleResult[]): {
  verdict: Decision["verdict"];
  blockedBy: string[];
  confirmRequiredBy: string[];
} {
  const blockedBy = results.filter((r) => r.verdict === "BLOCK").map((r) => r.rule);
  const confirmRequiredBy = results.filter((r) => r.verdict === "CONFIRM").map((r) => r.rule);

  const verdict: Decision["verdict"] =
    blockedBy.length > 0 ? "BLOCK" : confirmRequiredBy.length > 0 ? "CONFIRM" : "ALLOW";

  return { verdict, blockedBy, confirmRequiredBy };
}

/**
 * Evaluate one proposed order.
 *
 * Throws InvalidOrderError for malformed input - that is a bug in the caller,
 * not a policy decision, and conflating the two would let a typo read as a
 * clean pass.
 */
export function evaluate(order: ProposedOrder, ctx: EvaluationContext): Decision {
  validateOrder(order);

  const results: RuleResult[] = [];
  for (const rule of ALL_RULES) {
    const result = rule.evaluate(order, ctx);
    if (result !== null) results.push(result);
  }

  const { verdict, blockedBy, confirmRequiredBy } = reduceVerdict(results);

  return {
    verdict,
    order,
    notionalUsd: orderNotionalUsd(order, ctx.markPrice),
    markPrice: ctx.markPrice,
    results,
    blockedBy,
    confirmRequiredBy,
    timestamp: ctx.now.toISOString(),
  };
}

/** Rules the user has actually switched on, for the "what protects me" view. */
export function activeRules(policy: Policy): { name: string; purpose: string }[] {
  return ALL_RULES.filter((r) => r.isConfigured(policy)).map((r) => ({
    name: r.name,
    purpose: r.purpose,
  }));
}
