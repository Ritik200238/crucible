/**
 * Core domain types.
 *
 * The shape of the product is one pipeline: an intent becomes a snapshot,
 * a snapshot becomes costs, costs become a plan, a plan becomes a receipt.
 * Every stage after the snapshot is a pure function of it, which is what makes
 * a routing decision reproducible from its fingerprint alone.
 */

export type Side = "BUY" | "SELL";

/** Where an order can be filled. */
export type Venue = "BINANCE_SPOT" | "ONCHAIN";

/** How it is filled once a venue is chosen. */
export type Style = "TAKER" | "MAKER" | "SLICED";

/** What the caller wants to trade, before anything has been priced. */
export interface Intent {
  symbol: string;
  side: Side;
  /** Size in the quote asset, e.g. 500 USDT. Exactly one of these is set. */
  quoteQty?: number;
  /** Size in the base asset, e.g. 0.65 BNB. */
  baseQty?: number;
}

// ---------------------------------------------------------------------------
// Market state
// ---------------------------------------------------------------------------

/** One resting price level. Quantities are in the base asset. */
export interface BookLevel {
  price: number;
  qty: number;
}

export interface OrderBook {
  /** Highest first. */
  bids: BookLevel[];
  /** Lowest first. */
  asks: BookLevel[];
  lastUpdateId: number;
}

/**
 * The exchange's own constraints on an order.
 *
 * Field names match Binance's `exchangeInfo` filters so a reader can map them
 * back to the source: LOT_SIZE.stepSize, PRICE_FILTER.tickSize,
 * NOTIONAL.minNotional.
 */
export interface SymbolFilters {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  baseAssetPrecision: number;
  quoteAssetPrecision: number;
  stepSize: number;
  minQty: number;
  maxQty: number;
  tickSize: number;
  minNotional: number;
}

/**
 * Fees actually charged to this account, as fractions (0.001 = 10 bps).
 *
 * `source` records whether these were read from the account or fallen back to
 * the public VIP-0 schedule. A cost model quoting fees it could not verify has
 * to say so, because the whole product is a comparison of small numbers.
 */
export interface CommissionRates {
  maker: number;
  taker: number;
  source: "account" | "vip0-default";
}

/** A price from the on-chain pool, per fee tier. */
export interface OnchainTierQuote {
  /** Pool fee in hundredths of a bip: 100 = 0.01%, 2500 = 0.25%. */
  feeTier: number;
  /** Units of the output token received for the requested input. */
  amountOut: number;
  /** Effective price, quote per base. */
  price: number;
  /** The quoter's own gas estimate for the swap. */
  gasEstimate: number;
}

export interface OnchainQuote {
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  tiers: OnchainTierQuote[];
  /** The tier with the best output for this size. Null when none answered. */
  best: OnchainTierQuote | null;
  gasPriceWei: number;
  /** Cost of the swap in USD at the current gas price. */
  gasCostUsd: number;
  /**
   * The pool's price for a size small enough to move it almost none, on the
   * same tier as `best`.
   *
   * This exists to keep the cost breakdown honest. Measuring impact against the
   * Binance mid conflates two different things: how far this order pushes the
   * pool, and how far the pool was already trading from the exchange. The first
   * is a cost of the order; the second is a property of the market that can go
   * either way. Separating them needs a near-zero-size reference, which is what
   * this is.
   */
  referencePrice: number | null;
  /** Independent quote from the wallet CLI, when a session exists. */
  walletQuote: WalletQuote | null;
}

/** The executable quote from the Agentic Wallet, which is what actually fills. */
export interface WalletQuote {
  fromSymbol: string;
  toSymbol: string;
  amountIn: number;
  amountOut: number;
  slippage: number;
}

/** Base-asset volume per second arriving on each side, measured, not assumed. */
export interface TradeFlow {
  /** Sellers crossing into the bid. This is what fills a resting buy. */
  hitsBidPerSec: number;
  /** Buyers lifting the ask. This is what fills a resting sell. */
  liftsAskPerSec: number;
  /** Seconds the measurement spans. A short window is a weak measurement. */
  windowSec: number;
  /**
   * How far the market moves against a passive fill, in bps, measured from the
   * recent tape. Positive is a cost.
   */
  adverseBuyBps: number;
  adverseSellBps: number;
  /** Fills the adverse-selection figures were averaged over. */
  adverseSamples: number;
}

/**
 * Everything the decision is allowed to depend on, captured at one instant.
 *
 * Hashed and stored with every decision. Two snapshots with the same hash must
 * produce the same plan, which is the property the whole audit trail rests on.
 */
export interface Snapshot {
  symbol: string;
  takenAt: number;
  /** Mid of the Binance book. All costs are quoted in bps of this. */
  mid: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  book: OrderBook;
  filters: SymbolFilters;
  commission: CommissionRates;
  flow: TradeFlow;
  onchain: OnchainQuote | null;
  /** Reason the on-chain side is absent, when it is. */
  onchainUnavailable?: string;
  hash: string;
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/** One named component of a cost, in basis points of mid. */
export interface CostComponent {
  name: string;
  bps: number;
  /** Plain-English note shown in the report. */
  detail: string;
  /** True when this figure is modelled rather than read from a venue. */
  estimated?: boolean;
}

export interface CostEstimate {
  venue: Venue;
  style: Style;
  components: CostComponent[];
  /** Sum of the components. */
  totalBps: number;
  totalUsd: number;
  /** Expected average fill price after all costs. */
  effectivePrice: number;
  /** Present when this route cannot be used, with the reason. */
  unavailable?: string;
  /** True when any component is modelled. */
  hasEstimates: boolean;
  /**
   * Real risks of this route that carry no expected cost, so they are named
   * rather than priced.
   *
   * Some things a route exposes you to have an expected value of zero and a
   * variance that is not zero — price drift while a swap settles is the obvious
   * one. Inventing a number for those would be a guess dressed as a measurement,
   * and leaving them out entirely would let a cheaper-looking route hide a risk
   * the other one does not carry. So they are stated.
   */
  notes: string[];
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** One child order of a sliced execution. */
export interface Slice {
  index: number;
  baseQty: number;
  /** Milliseconds after the plan starts that this child should be sent. */
  offsetMs: number;
}

export interface Plan {
  id: string;
  /** SHA-256 over intent, snapshot hash and policy hash. */
  fingerprint: string;
  intent: Intent;
  snapshotHash: string;
  createdAt: number;
  /** A plan cannot execute after this. It is re-priced, never replayed. */
  expiresAt: number;
  chosen: CostEstimate;
  alternatives: CostEstimate[];
  /** Saving against the best rejected route, in bps and dollars. */
  savingBps: number;
  savingUsd: number;
  baseQty: number;
  quoteQty: number;
  slices: Slice[];
  /** Why this route, in one sentence. */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Execution and receipts
// ---------------------------------------------------------------------------

export type FillStatus = "FILLED" | "PARTIAL" | "FAILED" | "PENDING";

/** Commission charged, in the asset it was actually charged in. */
export interface FeeCharge {
  asset: string;
  amount: number;
  /**
   * Value in the quote asset, when it can be established.
   *
   * Null rather than zero when the rate is unknown. An exchange can split one
   * order's commission across assets, and the amounts are not comparable as raw
   * numbers: 0.002 BNB is worth more than 0.9 USDT. Reporting an unpriced fee as
   * zero would understate the cost of exactly the fills that are hardest to
   * price.
   */
  valueInQuote: number | null;
}

/** A fill as re-read from the venue, never as returned by the placing call. */
export interface ConfirmedFill {
  venue: Venue;
  status: FillStatus;
  filledBaseQty: number;
  filledQuoteQty: number;
  avgPrice: number;
  /** Every asset the commission was taken in. Never reduced to one. */
  fees: FeeCharge[];
  /** Sum of the fees that could be priced. Null when none could be. */
  totalFeeInQuote: number | null;
  isMaker: boolean | null;
  /** Exchange order id, or the on-chain transaction hash. */
  reference: string;
  confirmedBy: string;
}

export interface Receipt {
  planId: string;
  fingerprint: string;
  intent: Intent;
  predicted: CostEstimate;
  alternative: CostEstimate | null;
  fills: ConfirmedFill[];
  /** What the fill price alone cost against mid, before commission. */
  realisedGrossBps: number;
  /**
   * Commission as a share of what traded. Null when it was charged in an asset
   * that cannot be priced from this fill.
   */
  realisedFeeBps: number | null;
  /**
   * The full realised cost: price against mid plus commission.
   *
   * Null when the fee could not be priced. The prediction includes commission
   * as its largest component, so a realised figure that silently omitted it
   * would understate the cost by roughly one commission every time — and this
   * is the number the whole model is judged against.
   */
  realisedBps: number | null;
  realisedUsd: number | null;
  /** Realised minus predicted. Null when realised could not be completed. */
  errorBps: number | null;
  /** Why the comparison could not be made, when it could not. */
  errorUnavailable?: string;
  savingBps: number | null;
  savingUsd: number | null;
  completedAt: number;
}

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

export type Market = "SPOT" | "MARGIN" | "USDM_FUTURES" | "COINM_FUTURES";
export type OrderType = "MARKET" | "LIMIT";

/** An order as the risk engine sees it. */
export interface ProposedOrder {
  symbol: string;
  side: Side;
  type: OrderType;
  market: Market;
  quantity?: number;
  quoteOrderQty?: number;
  price?: number;
  leverage?: number;
  reduceOnly?: boolean;
  /** Set once a route is chosen, so venue-aware rules can act on it. */
  venue?: Venue;
}

export interface Position {
  symbol: string;
  notionalUsd: number;
}

export interface AccountSnapshot {
  equityUsd: number;
  positions: Position[];
  realisedPnlTodayUsd: number;
  source: "live" | "simulated";
}

export type Verdict = "ALLOW" | "CONFIRM" | "BLOCK";

export interface RuleResult {
  rule: string;
  verdict: Verdict;
  message: string;
  detail?: Record<string, unknown>;
}

export interface Decision {
  verdict: Verdict;
  order: ProposedOrder;
  notionalUsd: number;
  markPrice: number;
  results: RuleResult[];
  blockedBy: string[];
  confirmRequiredBy: string[];
  timestamp: string;
}

export interface NoTradeWindow {
  start: string;
  end: string;
  label?: string;
}

/**
 * The operator's rules. Every field is optional; an absent rule is not
 * enforced, and `crucible policy` reports exactly which ones are live.
 */
export interface Policy {
  version: number;
  mode: "dry-run" | "live";
  maxOrderNotionalUsd?: number;
  maxDailyNotionalUsd?: number;
  maxPositionPctOfEquity?: number;
  maxLeverage?: number;
  dailyLossLimitPct?: number;
  symbolAllowlist?: string[];
  symbolDenylist?: string[];
  cooldownAfterLossMinutes?: number;
  maxOrdersPerHour?: number;
  confirmAboveNotionalUsd?: number;
  noTradeWindowsUtc?: NoTradeWindow[];
  allowedMarkets?: Market[];

  // Execution rules. These are what make the risk engine specific to routing
  // rather than to trading in general.

  /** Refuse when walking the book for this size costs more than this. */
  maxImpactBps?: number;
  /** Refuse when the quote has drifted more than this between plan and send. */
  maxSlippageBps?: number;
  /** Refuse when less than this much rests within `depthWindowBps` of mid. */
  minDepthNotionalUsd?: number;
  depthWindowBps?: number;
  /** Refuse a decision made on a snapshot older than this. */
  snapshotMaxAgeMs?: number;
  venueAllowlist?: Venue[];
  /** Refuse when the two independent on-chain quotes disagree by more. */
  maxQuoteDisagreementBps?: number;
}

export interface RollingState {
  day: string;
  notionalTodayUsd: number;
  ordersToday: number;
  recentOrderTimes: string[];
  lastLossAt: string | null;
  realisedPnlTodayUsd: number;
}

export interface EvaluationContext {
  policy: Policy;
  account: AccountSnapshot;
  state: RollingState;
  markPrice: number;
  now: Date;
  /** Present for execution rules; absent when only the base rules apply. */
  snapshot?: Snapshot;
  /** Impact of this order against the live book, in bps. */
  impactBps?: number;
}

export interface Rule {
  name: string;
  purpose: string;
  isConfigured(policy: Policy): boolean;
  evaluate(order: ProposedOrder, ctx: EvaluationContext): RuleResult | null;
}
