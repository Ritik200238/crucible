import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_POLICY } from "../src/config.ts";
import { priceAllRoutes } from "../src/cost/model.ts";
import { measuredImpactBps, route, RouteError } from "../src/decide/router.ts";
import { deriveState } from "../src/risk/state.ts";
import { execute, ExecutionError, UnconfirmedError } from "../src/exec/execute.ts";
import type { Credentials } from "../src/exec/binance-rest.ts";
import { Ledger } from "../src/ledger/chain.ts";
import { verifyChain, verifyLedger } from "../src/ledger/verify.ts";
import { evaluate } from "../src/risk/engine.ts";
import { hashSnapshot } from "../src/snapshot.ts";
import type {
  AccountSnapshot,
  Intent,
  OrderBook,
  Plan,
  Policy,
  ProposedOrder,
  RollingState,
  Snapshot,
} from "../src/types.ts";

// The whole pipeline, end to end, against a venue that lives in this process:
// snapshot -> cost model -> route -> risk engine -> execute -> receipt -> ledger.
//
// Two things are load-bearing here and are asserted rather than assumed. The
// first is that no byte leaves the machine: the exchange client is driven by an
// injected fetch, and the global one is replaced with a function that throws and
// records the attempt. The second is that no test reaches the on-chain leg,
// because that leg shells out to the wallet CLI - so the snapshot carries no
// pool quote and the policy allows only the exchange.

const MID = 752;
const BEST_BID = 751.99;
const BEST_ASK = 752.01;
const TAKEN_AT = 1_762_000_000_000;

const VENUE_URL = "https://simulated-venue.invalid";
const CREDENTIALS: Credentials = {
  apiKey: "e2e-key",
  secret: "e2e-secret-that-never-leaves-this-process",
  scheme: "HMAC",
};

/** Basis points are a division; exact equality is the wrong test for them. */
function closeTo(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

// ---------------------------------------------------------------------------
// Market state
// ---------------------------------------------------------------------------

/** Four levels a side, deep enough to clear the policy's depth floor. */
const DEEP_BOOK: OrderBook = {
  bids: [
    { price: 751.99, qty: 5 },
    { price: 751.98, qty: 5 },
    { price: 751.97, qty: 5 },
    { price: 751.96, qty: 5 },
  ],
  asks: [
    { price: 752.01, qty: 5 },
    { price: 752.02, qty: 5 },
    { price: 752.03, qty: 5 },
    { price: 752.04, qty: 5 },
  ],
  lastUpdateId: 81_004_422,
};

/** One unit a level, half a dollar apart, so three units move the book visibly. */
const THIN_BOOK: OrderBook = {
  bids: [
    { price: 751.99, qty: 5 },
    { price: 751.49, qty: 5 },
  ],
  asks: [
    { price: 752.01, qty: 1 },
    { price: 752.51, qty: 1 },
    { price: 753.01, qty: 1 },
    { price: 753.51, qty: 5 },
  ],
  lastUpdateId: 81_004_931,
};

function makeSnapshot(book: OrderBook, adverseBps: number): Snapshot {
  const partial: Omit<Snapshot, "hash"> = {
    symbol: "BNBUSDT",
    takenAt: TAKEN_AT,
    mid: MID,
    bestBid: BEST_BID,
    bestAsk: BEST_ASK,
    spreadBps: ((BEST_ASK - BEST_BID) / MID) * 10_000,
    book,
    filters: {
      symbol: "BNBUSDT",
      baseAsset: "BNB",
      quoteAsset: "USDT",
      baseAssetPrecision: 8,
      quoteAssetPrecision: 8,
      stepSize: 0.001,
      minQty: 0.001,
      maxQty: 9000,
      tickSize: 0.01,
      minNotional: 5,
    },
    // Read from the account rather than the public schedule, which makes the
    // taker route a measured cost and keeps the router's estimate handicap out
    // of the venue choice these tests depend on.
    commission: { maker: 0.001, taker: 0.001, source: "account" },
    flow: {
      hitsBidPerSec: 2,
      liftsAskPerSec: 2,
      windowSec: 60,
      adverseBuyBps: adverseBps,
      adverseSellBps: adverseBps,
      adverseSamples: 40, volExchangeBps: 1.5, volSettlementBps: 1.8,
    },
    onchain: null,
    onchainUnavailable: "This run prices the exchange leg only; no pool was quoted.",
  };
  return { ...partial, hash: hashSnapshot(partial) };
}

const DEEP = makeSnapshot(DEEP_BOOK, 1.5);
/** Thin book, and flow hostile enough that resting is the worse of the two. */
const THIN = makeSnapshot(THIN_BOOK, 10);

const LIVE_POLICY: Policy = {
  ...DEFAULT_POLICY,
  mode: "live",
  venueAllowlist: ["BINANCE_SPOT"],
};
const DRY_RUN_POLICY: Policy = { ...LIVE_POLICY, mode: "dry-run" };
/** Low enough that three units through the thin book breach it. */
const SLICING_POLICY: Policy = { ...LIVE_POLICY, maxImpactBps: 2.5 };

const ACCOUNT: AccountSnapshot = {
  equityUsd: 50_000,
  positions: [],
  realisedPnlTodayUsd: 0,
  source: "simulated",
};

const STATE: RollingState = {
  day: new Date(TAKEN_AT).toISOString().slice(0, 10),
  notionalTodayUsd: 0,
  ordersToday: 0,
  recentOrderTimes: [],
  lastLossAt: null,
  realisedPnlTodayUsd: 0,
};

const BUY_TWO: Intent = { symbol: "BNBUSDT", side: "BUY", baseQty: 2 };
const BUY_THREE: Intent = { symbol: "BNBUSDT", side: "BUY", baseQty: 3 };

// ---------------------------------------------------------------------------
// The simulated venue
// ---------------------------------------------------------------------------

interface VenueCall {
  method: string;
  path: string;
  params: URLSearchParams;
}

/** The order fields the client reads, as Binance sends them: strings. */
interface RawOrder {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  transactTime: number;
  price: string;
  origQty: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  status: string;
  type: string;
  side: string;
}

interface RawTrade {
  id: number;
  orderId: number;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  isMaker: boolean;
  time: number;
}

interface VenueOptions {
  /** GET /api/v3/order answers NEW this many times before it answers FILLED. */
  pollsBeforeFill?: number;
  /** The order stays NEW however often it is read. */
  neverFills?: boolean;
  /**
   * Answer the placing call as though the order had already filled in full,
   * while the read-back keeps its real state.
   *
   * A venue that contradicts itself in exactly this way is the only thing that
   * can tell whether an outcome was confirmed or simply believed.
   */
  placingResponseClaimsFilled?: boolean;
  /** Answer POST /api/v3/order with this rejection instead of accepting it. */
  rejectOrder?: { status: number; code: number; msg: string };
}

interface SimulatedVenue {
  fetchImpl: typeof fetch;
  calls: VenueCall[];
  /** Every request as "METHOD /path", in the order it arrived. */
  sequence(): string[];
  /** Each order exactly as the placing call answered it, before any read-back. */
  placed: RawOrder[];
  /** An order as it stands now, which is what the last read of it returned. */
  confirmed(orderId: number): RawOrder;
}

/** Each fill is matched in two trades, so fee and price aggregation are exercised. */
const FILL_PRICES = [752.01, 752.05];
const COMMISSION_RATE = 0.001;

function simulatedVenue(opts: VenueOptions = {}): SimulatedVenue {
  const calls: VenueCall[] = [];
  const placed: RawOrder[] = [];
  const orders = new Map<number, RawOrder>();
  const trades = new Map<number, RawTrade[]>();
  const reads = new Map<number, number>();
  let nextOrderId = 5_100_200;
  let nextTradeId = 900_100;

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  /** Match the order in full and write the trade records behind it. */
  const matchOrder = (order: RawOrder): void => {
    const qty = Number(order.origQty);
    const perTrade = qty / FILL_PRICES.length;
    const records = FILL_PRICES.map((price) => ({
      id: nextTradeId++,
      orderId: order.orderId,
      price: String(price),
      qty: String(perTrade),
      quoteQty: String(perTrade * price),
      // A spot buy is charged in the asset it receives.
      commission: String(perTrade * COMMISSION_RATE),
      commissionAsset: "BNB",
      isMaker: false,
      time: order.transactTime + 12,
    }));
    trades.set(order.orderId, records);
    order.executedQty = String(qty);
    order.cummulativeQuoteQty = String(records.reduce((a, t) => a + Number(t.quoteQty), 0));
    order.status = "FILLED";
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const href =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path: url.pathname, params: url.searchParams });

    if (method === "GET" && url.pathname === "/api/v3/time") {
      return json({ serverTime: Date.now() });
    }

    if (method === "POST" && url.pathname === "/api/v3/order/test") {
      return json({});
    }

    if (method === "POST" && url.pathname === "/api/v3/order") {
      if (opts.rejectOrder) {
        const { status, code, msg } = opts.rejectOrder;
        return json({ code, msg }, status);
      }
      const orderId = nextOrderId++;
      const order: RawOrder = {
        symbol: url.searchParams.get("symbol") ?? "",
        orderId,
        clientOrderId: url.searchParams.get("newClientOrderId") ?? "",
        transactTime: Date.now(),
        price: "0.00000000",
        origQty: String(Number(url.searchParams.get("quantity"))),
        // A real exchange can and does answer a market order with nothing filled
        // yet. Answering that way every time is what makes the read-back the only
        // possible source of the outcome.
        executedQty: "0.00000000",
        cummulativeQuoteQty: "0.00000000",
        status: "NEW",
        type: url.searchParams.get("type") ?? "",
        side: url.searchParams.get("side") ?? "",
      };
      orders.set(orderId, order);
      reads.set(orderId, 0);

      const answer: RawOrder = opts.placingResponseClaimsFilled
        ? {
            ...order,
            executedQty: order.origQty,
            cummulativeQuoteQty: String(Number(order.origQty) * FILL_PRICES[0]!),
            status: "FILLED",
          }
        : { ...order };
      placed.push(answer);
      return json({ ...answer, fills: [] });
    }

    if (method === "GET" && url.pathname === "/api/v3/order") {
      const orderId = Number(url.searchParams.get("orderId"));
      const order = orders.get(orderId);
      if (!order) return json({ code: -2013, msg: "Order does not exist." }, 400);

      const seen = (reads.get(orderId) ?? 0) + 1;
      reads.set(orderId, seen);
      if (!opts.neverFills && order.status === "NEW" && seen > (opts.pollsBeforeFill ?? 0)) {
        matchOrder(order);
      }
      return json(order);
    }

    if (method === "GET" && url.pathname === "/api/v3/myTrades") {
      return json(trades.get(Number(url.searchParams.get("orderId"))) ?? []);
    }

    return json(
      { code: -1121, msg: `This venue has no route for ${method} ${url.pathname}.` },
      404,
    );
  };

  return {
    fetchImpl,
    calls,
    placed,
    sequence: () => calls.map((c) => `${c.method} ${c.path}`),
    confirmed(orderId) {
      const order = orders.get(orderId);
      if (!order) throw new Error(`The simulated venue never issued order ${orderId}.`);
      return { ...order };
    },
  };
}

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

/** Every host a test tried to reach through the global fetch. Must stay empty. */
const leaked: string[] = [];
let realFetch: typeof fetch;
let ledgerRoot: string;

const savedLive = process.env.CRUCIBLE_LIVE;

before(() => {
  ledgerRoot = mkdtempSync(join(tmpdir(), "crucible-e2e-"));
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const where =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    leaked.push(where);
    throw new Error(
      `A test reached the global fetch for ${where}. Nothing in this file may open a socket; ` +
        `pass the request through the venue's fetchImpl instead.`,
    );
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  rmSync(ledgerRoot, { recursive: true, force: true });
});

afterEach(() => {
  // Both switches are restored after every test, so one test setting CRUCIBLE_LIVE
  // can never be the reason the next one is allowed to transmit.
  if (savedLive === undefined) delete process.env.CRUCIBLE_LIVE;
  else process.env.CRUCIBLE_LIVE = savedLive;
  assert.deepEqual(leaked, [], "a test reached the network");
});

function ledgerIn(name: string): Ledger {
  return new Ledger({ dir: join(ledgerRoot, name) });
}

/** One execution, wired to its own ledger and its own venue. */
function pipeline(
  name: string,
  venue: SimulatedVenue,
  policy: Policy,
  plan: Plan,
  snapshot: Snapshot = DEEP,
  now: number = TAKEN_AT,
) {
  const ledger = ledgerIn(name);
  return {
    ledger,
    run: () =>
      execute({
        plan,
        snapshot,
        policy,
        ledger,
        now,
        binance: { baseUrl: VENUE_URL, credentials: CREDENTIALS, fetchImpl: venue.fetchImpl },
      }),
  };
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test("a buy is priced, cleared, sent and receipted end to end", async () => {
  const plan = route({ intent: BUY_TWO, snapshot: DEEP, policy: LIVE_POLICY });

  // Both venues were priced. On-chain is out for a stated reason, which is also
  // why nothing in this file can spawn the wallet.
  const routes = priceAllRoutes({ snapshot: DEEP, side: "BUY", baseQty: plan.baseQty });
  assert.deepEqual(
    routes.map((r) => `${r.venue}/${r.style}`),
    ["BINANCE_SPOT/TAKER", "BINANCE_SPOT/MAKER", "ONCHAIN/TAKER"],
  );
  assert.equal(routes[2]!.unavailable, DEEP.onchainUnavailable);

  assert.equal(plan.chosen.venue, "BINANCE_SPOT");
  assert.equal(plan.chosen.style, "TAKER");
  assert.equal(plan.baseQty, 2);
  assert.equal(plan.slices.length, 0);

  const order: ProposedOrder = {
    symbol: DEEP.symbol,
    side: BUY_TWO.side,
    type: "MARKET",
    market: "SPOT",
    quantity: plan.baseQty,
    venue: plan.chosen.venue,
  };
  const decision = evaluate(order, {
    policy: LIVE_POLICY,
    account: ACCOUNT,
    state: STATE,
    markPrice: DEEP.mid,
    now: new Date(TAKEN_AT),
    snapshot: DEEP,
    impactBps: measuredImpactBps(DEEP, order.side, plan.baseQty),
  });
  assert.equal(decision.verdict, "ALLOW");
  assert.deepEqual(decision.blockedBy, []);
  assert.deepEqual(decision.confirmRequiredBy, []);

  process.env.CRUCIBLE_LIVE = "1";
  const venue = simulatedVenue();
  const receipt = await pipeline("happy-path", venue, LIVE_POLICY, plan).run();

  assert.equal(receipt.planId, plan.id);
  assert.equal(receipt.fingerprint, plan.fingerprint);
  assert.equal(receipt.fills.length, 1);

  const fill = receipt.fills[0]!;
  assert.equal(fill.venue, "BINANCE_SPOT");
  assert.equal(fill.status, "FILLED");
  assert.equal(fill.filledBaseQty, plan.baseQty);
  assert.equal(fill.isMaker, false);

  const settled = venue.confirmed(Number(fill.reference));
  assert.equal(fill.avgPrice, Number(settled.cummulativeQuoteQty) / Number(settled.executedQty));

  // Commission was charged in BNB across both trades and priced at the fill's own
  // average, because a base-asset fee has no other rate to convert at.
  assert.deepEqual(
    fill.fees.map((f) => f.asset),
    ["BNB"],
  );
  closeTo(fill.fees[0]!.amount, plan.baseQty * COMMISSION_RATE);
  assert.notEqual(fill.totalFeeInQuote, null);
  closeTo(fill.totalFeeInQuote!, plan.baseQty * COMMISSION_RATE * fill.avgPrice);

  // The realised cost is the fill price against the mid the plan was priced on,
  // plus the commission. Both halves are reported separately so a reader can
  // see which moved, and the total is what the prediction is judged against —
  // the prediction carries the taker fee too, so a price-only figure would be
  // wrong by about one commission every time.
  closeTo(receipt.realisedGrossBps, ((fill.avgPrice - DEEP.mid) / DEEP.mid) * 10_000);
  closeTo(receipt.realisedFeeBps!, COMMISSION_RATE * 10_000, 1e-6);
  closeTo(receipt.realisedBps!, receipt.realisedGrossBps + receipt.realisedFeeBps!);
  closeTo(receipt.errorBps!, receipt.realisedBps! - plan.chosen.totalBps);

  // The whole point of the change: a clean fill should show the model close to
  // right, not out by the size of the fee.
  assert.ok(
    Math.abs(receipt.errorBps!) < 1,
    `a clean fill should land within a basis point of the prediction, got ${receipt.errorBps}`,
  );

  assert.deepEqual(venue.sequence(), [
    "GET /api/v3/time",
    "POST /api/v3/order/test",
    "POST /api/v3/order",
    "GET /api/v3/order",
    "GET /api/v3/myTrades",
  ]);
  assert.deepEqual(leaked, []);
});

test("the order is validated before it is transmitted, and carries the plan id", async () => {
  process.env.CRUCIBLE_LIVE = "1";
  const plan = route({ intent: BUY_TWO, snapshot: DEEP, policy: LIVE_POLICY });
  const venue = simulatedVenue();
  await pipeline("validate-first", venue, LIVE_POLICY, plan).run();

  const validated = venue.sequence().indexOf("POST /api/v3/order/test");
  const transmitted = venue.sequence().indexOf("POST /api/v3/order");
  assert.notEqual(validated, -1);
  assert.ok(
    validated < transmitted,
    `validation at ${validated} must precede transmission at ${transmitted}`,
  );

  const check = venue.calls[validated]!;
  const sent = venue.calls[transmitted]!;
  const clientOrderId = sent.params.get("newClientOrderId");

  // The order that was validated has to be the order that was sent, or the check
  // proves nothing about what went out.
  assert.equal(check.params.get("symbol"), sent.params.get("symbol"));
  assert.equal(check.params.get("side"), sent.params.get("side"));
  assert.equal(check.params.get("quantity"), sent.params.get("quantity"));
  assert.equal(check.params.get("newClientOrderId"), clientOrderId);

  assert.ok(
    clientOrderId?.includes(plan.id),
    `client order id ${clientOrderId} must name plan ${plan.id}`,
  );
  assert.equal(venue.placed[0]!.clientOrderId, clientOrderId);
});

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

test("the fill is read back from the venue, never taken from the placing response", async () => {
  process.env.CRUCIBLE_LIVE = "1";
  const plan = route({ intent: BUY_TWO, snapshot: DEEP, policy: LIVE_POLICY });
  const venue = simulatedVenue({ pollsBeforeFill: 2 });
  const receipt = await pipeline("read-back", venue, LIVE_POLICY, plan).run();

  const placingResponse = venue.placed[0]!;
  assert.equal(placingResponse.status, "NEW");
  assert.equal(Number(placingResponse.executedQty), 0);
  assert.equal(Number(placingResponse.cummulativeQuoteQty), 0);

  const reads = venue.calls.filter((c) => c.method === "GET" && c.path === "/api/v3/order");
  assert.equal(reads.length, 3);

  const fill = receipt.fills[0]!;
  const settled = venue.confirmed(placingResponse.orderId);
  assert.equal(settled.status, "FILLED");
  assert.equal(fill.status, "FILLED");
  assert.equal(fill.filledBaseQty, Number(settled.executedQty));
  assert.equal(fill.filledBaseQty, plan.baseQty);
  assert.equal(fill.filledQuoteQty, Number(settled.cummulativeQuoteQty));
  assert.match(fill.confirmedBy, /^GET \/api\/v3\/order plus 2 trade record\(s\)$/);
});

test("an order that never leaves NEW is reported as unresolved, not as a fill", async (t) => {
  process.env.CRUCIBLE_LIVE = "1";
  const plan = route({ intent: BUY_TWO, snapshot: DEEP, policy: LIVE_POLICY });
  // The placing call claims a complete fill and the read-back never leaves NEW.
  // Anything that believed the placing response would hand back a receipt here.
  const venue = simulatedVenue({ neverFills: true, placingResponseClaimsFilled: true });
  const { ledger, run } = pipeline("never-fills", venue, LIVE_POLICY, plan);

  // The client polls for thirty seconds before it gives up. Nothing waits for
  // that: the clock is mocked and driven forward between turns of the loop.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: TAKEN_AT });

  let settled: unknown;
  const attempt = run().then(
    (receipt) => {
      settled = receipt;
    },
    (err: unknown) => {
      settled = err;
    },
  );
  for (let i = 0; i < 400 && settled === undefined; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(600);
  }
  await attempt;

  assert.equal(venue.placed[0]!.status, "FILLED");
  // Not a failure. The order left, and the honest state is unknown — which is
  // its own class so a caller can tell "retry" apart from "do not retry".
  assert.ok(
    settled instanceof UnconfirmedError,
    `expected an UnconfirmedError, got ${String(settled)}`,
  );
  const orderId = String(venue.placed[0]!.orderId);
  assert.ok(
    settled.message.includes(orderId),
    `the message must name order ${orderId}: ${settled.message}`,
  );
  assert.match(settled.message, /still NEW/);
  assert.match(settled.message, /crucible reconcile --plan/);
  assert.match(settled.message, /Do not retry blind/);
  assert.equal(settled.submitted[0]!.reference, orderId);
  assert.equal(
    venue.calls.some((c) => c.path === "/api/v3/myTrades"),
    false,
  );
  assert.deepEqual(
    ledger.read().map((r) => r.kind),
    ["execution.started", "execution.submitted", "execution.unconfirmed"],
  );

  // The unresolved order holds its notional against the caps. Freeing it on a
  // timeout would let a slow network erase an order from the daily total.
  const state = deriveState(ledger.read(), TAKEN_AT);
  assert.equal(state.unresolved.length, 1);
  assert.equal(state.unresolved[0]!.reference, orderId);
  assert.equal(state.ordersToday, 1);
  closeTo(state.notionalTodayUsd, plan.baseQty * DEEP.mid);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test("a dry-run policy refuses, transmits nothing, and records the refusal", async () => {
  delete process.env.CRUCIBLE_LIVE;
  const plan = route({ intent: BUY_TWO, snapshot: DEEP, policy: DRY_RUN_POLICY });
  const venue = simulatedVenue();
  const { ledger, run } = pipeline("dry-run", venue, DRY_RUN_POLICY, plan);

  await assert.rejects(run(), (err: unknown) => {
    assert.ok(err instanceof ExecutionError);
    assert.match(err.message, /Policy mode is "dry-run"/);
    return true;
  });

  assert.deepEqual(venue.sequence(), []);
  const records = ledger.read();
  assert.deepEqual(
    records.map((r) => r.kind),
    ["execution.refused"],
  );
  assert.equal((records[0]!.payload as { planId: string }).planId, plan.id);
});

test("a live policy with CRUCIBLE_LIVE unset refuses and transmits nothing", async () => {
  delete process.env.CRUCIBLE_LIVE;
  const plan = route({ intent: BUY_TWO, snapshot: DEEP, policy: LIVE_POLICY });
  const venue = simulatedVenue();
  const { ledger, run } = pipeline("no-env-switch", venue, LIVE_POLICY, plan);

  await assert.rejects(run(), (err: unknown) => {
    assert.ok(err instanceof ExecutionError);
    assert.match(err.message, /CRUCIBLE_LIVE is not set to 1/);
    return true;
  });

  assert.deepEqual(venue.sequence(), []);
  assert.deepEqual(
    ledger.read().map((r) => r.kind),
    ["execution.refused"],
  );
});

test("an expired plan refuses and transmits nothing", async () => {
  process.env.CRUCIBLE_LIVE = "1";
  const plan = route({ intent: BUY_TWO, snapshot: DEEP, policy: LIVE_POLICY });
  const venue = simulatedVenue();
  const { ledger, run } = pipeline(
    "expired",
    venue,
    LIVE_POLICY,
    plan,
    DEEP,
    plan.expiresAt + 1_000,
  );

  await assert.rejects(run(), (err: unknown) => {
    assert.ok(err instanceof RouteError);
    assert.match(err.message, new RegExp(`Plan ${plan.id} expired`));
    return true;
  });

  assert.deepEqual(venue.sequence(), []);
  const records = ledger.read();
  assert.deepEqual(
    records.map((r) => r.kind),
    ["execution.refused"],
  );
  assert.match((records[0]!.payload as { reason: string }).reason, /expired/);
});

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

test("a completed execution leaves a signed, verifiable trail of records", async () => {
  process.env.CRUCIBLE_LIVE = "1";
  const plan = route({ intent: BUY_TWO, snapshot: DEEP, policy: LIVE_POLICY });
  const venue = simulatedVenue();
  const { ledger, run } = pipeline("completed", venue, LIVE_POLICY, plan);
  const receipt = await run();

  const records = ledger.read();
  assert.deepEqual(
    records.map((r) => r.kind),
    ["execution.started", "execution.submitted", "execution.completed"],
  );

  const started = records[0]!.payload as { venue: string; predictedBps: number };
  assert.equal(started.venue, "BINANCE_SPOT");
  closeTo(started.predictedBps, plan.chosen.totalBps);

  // The moment the exchange accepted it, with the exchange's own id, so a
  // crash between here and the read-back leaves a record of what was sent.
  const submitted = records[1]!.payload as { reference: string; quoteQty: number };
  assert.equal(submitted.reference, String(venue.placed[0]!.orderId));
  closeTo(submitted.quoteQty, plan.baseQty * DEEP.mid);

  const completed = records[2]!.payload as { realisedBps: number | null; errorBps: number | null };
  closeTo(completed.realisedBps, receipt.realisedBps);
  closeTo(completed.errorBps, receipt.errorBps);

  assert.equal(verifyChain(records).ok, true);

  const onDisk = verifyLedger({ dir: ledger.paths.dir });
  assert.equal(onDisk.ok, true);
  assert.equal(onDisk.records, 3);
  assert.equal(onDisk.signatureValid, true);
});

test("a rejected order is recorded verbatim and leaves the chain intact", async () => {
  process.env.CRUCIBLE_LIVE = "1";
  const plan = route({ intent: BUY_TWO, snapshot: DEEP, policy: LIVE_POLICY });
  const venue = simulatedVenue({
    rejectOrder: { status: 400, code: -2010, msg: "Account has insufficient balance" },
  });
  const { ledger, run } = pipeline("rejected", venue, LIVE_POLICY, plan);

  await assert.rejects(run(), (err: unknown) => {
    assert.ok(err instanceof ExecutionError);
    assert.match(err.message, /Account has insufficient balance/);
    return true;
  });

  // Validation passed, the order went out, and the exchange refused it there.
  assert.deepEqual(venue.sequence(), [
    "GET /api/v3/time",
    "POST /api/v3/order/test",
    "POST /api/v3/order",
  ]);

  const records = ledger.read();
  assert.deepEqual(
    records.map((r) => r.kind),
    ["execution.started", "execution.failed"],
  );
  assert.match(
    (records[1]!.payload as { reason: string }).reason,
    /Account has insufficient balance/,
  );
  assert.equal(verifyChain(records).ok, true);
  assert.equal(verifyLedger({ dir: ledger.paths.dir }).ok, true);
});

// ---------------------------------------------------------------------------
// Slicing
// ---------------------------------------------------------------------------

test("a sliced plan sends one validated order per child and sums their fills", async () => {
  process.env.CRUCIBLE_LIVE = "1";
  const routed = route({ intent: BUY_THREE, snapshot: THIN, policy: SLICING_POLICY });

  assert.equal(routed.chosen.venue, "BINANCE_SPOT");
  assert.equal(routed.chosen.style, "SLICED");
  assert.equal(routed.slices.length, 3);
  closeTo(
    routed.slices.reduce((a, s) => a + s.baseQty, 0),
    routed.baseQty,
  );

  // The schedule spaces the children thirty seconds apart. Collapsing it to zero
  // keeps the test off the clock; what is under test is one order per child, each
  // validated first, and the arithmetic that adds them back up.
  const plan: Plan = {
    ...routed,
    slices: routed.slices.map((s) => ({ ...s, offsetMs: 0 })),
  };

  const venue = simulatedVenue();
  const receipt = await pipeline("sliced", venue, SLICING_POLICY, plan, THIN).run();

  assert.deepEqual(venue.sequence(), [
    "GET /api/v3/time",
    "POST /api/v3/order/test",
    "POST /api/v3/order",
    "GET /api/v3/order",
    "GET /api/v3/myTrades",
    "POST /api/v3/order/test",
    "POST /api/v3/order",
    "GET /api/v3/order",
    "GET /api/v3/myTrades",
    "POST /api/v3/order/test",
    "POST /api/v3/order",
    "GET /api/v3/order",
    "GET /api/v3/myTrades",
  ]);

  const sentQuantities = venue.calls
    .filter((c) => c.method === "POST" && c.path === "/api/v3/order")
    .map((c) => Number(c.params.get("quantity")));
  assert.deepEqual(
    sentQuantities,
    plan.slices.map((s) => s.baseQty),
  );

  // Each child names its own index, so a receipt with three fills can be tied
  // back to three separate authorisations rather than one repeated.
  assert.deepEqual(
    venue.placed.map((o) => o.clientOrderId),
    [`cru-${plan.id}-0`, `cru-${plan.id}-1`, `cru-${plan.id}-2`],
  );

  assert.equal(receipt.fills.length, 3);
  closeTo(
    receipt.fills.reduce((a, f) => a + f.filledBaseQty, 0),
    plan.baseQty,
  );
  for (const fill of receipt.fills) assert.equal(fill.status, "FILLED");
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("the same snapshot and policy route and price identically twice", async () => {
  process.env.CRUCIBLE_LIVE = "1";

  const first = route({ intent: BUY_TWO, snapshot: DEEP, policy: LIVE_POLICY });
  const second = route({ intent: BUY_TWO, snapshot: DEEP, policy: LIVE_POLICY });

  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.id, second.id);
  assert.equal(first.snapshotHash, DEEP.hash);
  assert.equal(first.chosen.venue, second.chosen.venue);
  assert.equal(first.chosen.style, second.chosen.style);
  // Same inputs through the same arithmetic: identical to the last bit, not close.
  assert.equal(first.chosen.totalBps, second.chosen.totalBps);

  const firstReceipt = await pipeline(
    "determinism-a",
    simulatedVenue(),
    LIVE_POLICY,
    first,
  ).run();
  const secondReceipt = await pipeline(
    "determinism-b",
    simulatedVenue(),
    LIVE_POLICY,
    second,
  ).run();

  assert.equal(firstReceipt.predicted.totalBps, secondReceipt.predicted.totalBps);
  assert.equal(firstReceipt.fingerprint, secondReceipt.fingerprint);
  assert.equal(firstReceipt.realisedBps, secondReceipt.realisedBps);
  assert.equal(firstReceipt.errorBps, secondReceipt.errorBps);
});
