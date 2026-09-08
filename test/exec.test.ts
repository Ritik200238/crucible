import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, verify as verifySignature } from "node:crypto";

import {
  BinanceApiError,
  BinanceRest,
  DEMO,
  MAINNET,
  TESTNET,
  credentialsFromEnv,
  signQuery,
  toConfirmedFill,
  type Credentials,
} from "../src/exec/binance-rest.ts";
import { resolveCli } from "../src/exec/wallet.ts";
import type { SymbolFilters } from "../src/types.ts";

// Nothing in this file may reach Binance or spawn anything that can trade. The
// client takes a fetch implementation, so every request below is answered by a
// canned response and the exact bytes it would have sent are inspected instead.

const HMAC_SECRET = "hmac-secret-for-the-test-suite";
const CREDS: Credentials = { apiKey: "exec-test-key", secret: HMAC_SECRET, scheme: "HMAC" };

const FILTERS: SymbolFilters = {
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
};

type FetchArgs = Parameters<typeof fetch>;

interface FakeCall {
  url: string;
  init: FetchArgs[1];
}

interface Canned {
  status?: number;
  body: string;
}

/** A fetch that answers from `responder` and keeps every request for inspection. */
function fakeFetch(responder: (url: string, callIndex: number) => Canned): {
  fetchImpl: typeof fetch;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const canned = responder(url, calls.length - 1);
    return new Response(canned.body, { status: canned.status ?? 200 });
  };
  return { fetchImpl, calls };
}

function queryOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

function apiKeyHeader(call: FakeCall): string | null {
  return new Headers(call.init?.headers).get("X-MBX-APIKEY");
}

/** Fields the client reads back off an order. */
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

function rawOrder(over: Partial<RawOrder> = {}): RawOrder {
  return {
    symbol: "BNBUSDT",
    orderId: 424242,
    clientOrderId: "cru-9f2c1a4b7d03-0",
    transactTime: 1_757_337_600_123,
    price: "0.00000000",
    origQty: "2.00000000",
    executedQty: "2.00000000",
    cummulativeQuoteQty: "1505.50000000",
    status: "FILLED",
    type: "MARKET",
    side: "BUY",
    ...over,
  };
}

function rawTrade(over: Partial<RawTrade> = {}): RawTrade {
  return {
    id: 900_001,
    orderId: 424242,
    price: "752.75000000",
    qty: "2.00000000",
    quoteQty: "1505.50000000",
    commission: "0.00150000",
    commissionAsset: "BNB",
    isMaker: false,
    time: 1_757_337_600_123,
    ...over,
  };
}

/** Restores the named variables to whatever they were before the test ran. */
function saveEnv(names: string[]): () => void {
  const saved = names.map((name) => [name, process.env[name]] as const);
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

const SIGNED_QUERY =
  "symbol=BNBUSDT&side=BUY&type=MARKET&quantity=1&timestamp=1757337600000&recvWindow=5000";

test("an HMAC signature matches the digest of the same bytes", () => {
  const expected = createHmac("sha256", HMAC_SECRET).update(SIGNED_QUERY).digest("hex");

  assert.equal(signQuery(SIGNED_QUERY, CREDS), expected);
  // Pinned as well as recomputed: recomputing alone would still pass if both
  // sides were changed to the same wrong algorithm.
  assert.equal(
    signQuery(SIGNED_QUERY, CREDS),
    "cf892de1688782bc0d2f111f6b0e51ffff5eca6b9af7728adf203745ad2fbb57",
  );
});

test("an HMAC signature changes when the query does", () => {
  const one = signQuery(SIGNED_QUERY, CREDS);
  const two = signQuery(SIGNED_QUERY.replace("quantity=1", "quantity=2"), CREDS);
  const three = signQuery(SIGNED_QUERY, { ...CREDS, secret: `${HMAC_SECRET}x` });

  assert.notEqual(one, two);
  assert.notEqual(one, three);
});

test("an HMAC signature is lowercase hex", () => {
  const signature = signQuery(SIGNED_QUERY, CREDS);

  assert.match(signature, /^[0-9a-f]{64}$/);
  assert.equal(signature.length, 64);
});

test("an Ed25519 signature verifies against the matching public key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const creds: Credentials = { apiKey: "exec-test-key", secret: pem, scheme: "ED25519" };

  const signature = signQuery(SIGNED_QUERY, creds);

  assert.ok(
    verifySignature(null, Buffer.from(SIGNED_QUERY), publicKey, Buffer.from(signature, "base64")),
    "the signature did not verify, so it is not a real Ed25519 signature over the query",
  );
  assert.ok(
    !verifySignature(
      null,
      Buffer.from(`${SIGNED_QUERY}&quantity=999`),
      publicKey,
      Buffer.from(signature, "base64"),
    ),
    "a tampered query still verified, so the signature does not cover the whole query",
  );
});

// ---------------------------------------------------------------------------
// Credentials from the environment
// ---------------------------------------------------------------------------

test("credentialsFromEnv refuses when either variable is missing", () => {
  const restore = saveEnv(["BINANCE_API_KEY", "BINANCE_API_SECRET"]);
  try {
    delete process.env.BINANCE_API_KEY;
    delete process.env.BINANCE_API_SECRET;
    assert.throws(() => credentialsFromEnv(), (err: unknown) => {
      assert.ok(err instanceof BinanceApiError);
      assert.match(err.message, /BINANCE_API_KEY and BINANCE_API_SECRET/);
      return true;
    });

    process.env.BINANCE_API_KEY = "exec-test-key";
    assert.throws(() => credentialsFromEnv(), BinanceApiError);

    delete process.env.BINANCE_API_KEY;
    process.env.BINANCE_API_SECRET = HMAC_SECRET;
    assert.throws(() => credentialsFromEnv(), BinanceApiError);
  } finally {
    restore();
  }
});

test("credentialsFromEnv reads the signing scheme off the secret", () => {
  const restore = saveEnv(["BINANCE_API_KEY", "BINANCE_API_SECRET"]);
  try {
    process.env.BINANCE_API_KEY = "exec-test-key";

    process.env.BINANCE_API_SECRET = HMAC_SECRET;
    assert.equal(credentialsFromEnv().scheme, "HMAC");

    const { privateKey } = generateKeyPairSync("ed25519");
    process.env.BINANCE_API_SECRET = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const creds = credentialsFromEnv();
    assert.equal(creds.scheme, "ED25519");
    assert.equal(creds.apiKey, "exec-test-key");
  } finally {
    restore();
  }
});

test("credentialsFromEnv honours a custom prefix", () => {
  const restore = saveEnv([
    "BINANCE_API_KEY",
    "BINANCE_API_SECRET",
    "DEMO_API_KEY",
    "DEMO_API_SECRET",
  ]);
  try {
    delete process.env.BINANCE_API_KEY;
    delete process.env.BINANCE_API_SECRET;
    process.env.DEMO_API_KEY = "demo-key";
    process.env.DEMO_API_SECRET = "demo-secret";

    const creds = credentialsFromEnv("DEMO");
    assert.equal(creds.apiKey, "demo-key");
    assert.equal(creds.secret, "demo-secret");

    assert.throws(() => credentialsFromEnv("MISSING"), /MISSING_API_KEY and MISSING_API_SECRET/);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

test("the client refuses to start without a base URL", () => {
  assert.throws(
    () => new BinanceRest({ baseUrl: "", credentials: CREDS }),
    (err: unknown) => {
      assert.ok(err instanceof BinanceApiError);
      assert.match(err.message, /base URL is required/);
      return true;
    },
  );
});

test("isMainnet is true for mainnet and nothing else", () => {
  const on = (baseUrl: string) => new BinanceRest({ baseUrl, credentials: CREDS }).isMainnet;

  assert.equal(on(MAINNET), true);
  // A trailing slash is stripped, so it must not be a way to slip past the check.
  assert.equal(on(`${MAINNET}/`), true);
  assert.equal(on(DEMO), false);
  assert.equal(on(TESTNET), false);
});

test("recvWindow is clamped to the 60000 Binance accepts", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ body: "[]" }));
  const client = new BinanceRest({
    baseUrl: DEMO,
    credentials: CREDS,
    recvWindow: 500_000,
    fetchImpl,
  });

  await client.myTrades("BNBUSDT", 424242);

  assert.equal(queryOf(calls[0]!.url).get("recvWindow"), "60000");
});

// ---------------------------------------------------------------------------
// What goes on the wire
// ---------------------------------------------------------------------------

test("a signed request carries a timestamp, a recvWindow and a signature over the exact query", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ body: "[]" }));
  const client = new BinanceRest({ baseUrl: DEMO, credentials: CREDS, fetchImpl });
  const before = Date.now();

  await client.myTrades("BNBUSDT", 424242);

  const call = calls[0]!;
  const params = queryOf(call.url);
  assert.equal(params.get("symbol"), "BNBUSDT");
  assert.equal(params.get("orderId"), "424242");
  assert.equal(params.get("recvWindow"), "5000");
  assert.equal(apiKeyHeader(call), "exec-test-key");

  const timestamp = Number(params.get("timestamp"));
  assert.ok(
    timestamp >= before && timestamp <= Date.now(),
    `timestamp ${timestamp} is not this machine's clock without a sync`,
  );

  // The signature has to cover the query string as sent, character for
  // character, or Binance computes a different digest and rejects the request.
  const query = call.url.slice(call.url.indexOf("?") + 1);
  const cut = query.lastIndexOf("&signature=");
  const signed = query.slice(0, cut);
  const signature = query.slice(cut + "&signature=".length);
  assert.equal(signature, createHmac("sha256", HMAC_SECRET).update(signed).digest("hex"));
});

test("an unsigned request carries no timestamp, recvWindow or signature", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({
    body: JSON.stringify({ serverTime: 1_757_337_600_000 }),
  }));
  const client = new BinanceRest({ baseUrl: DEMO, credentials: CREDS, fetchImpl });

  await client.syncClock();

  const call = calls[0]!;
  assert.equal(call.url, `${DEMO}/api/v3/time`);
  assert.equal(call.url.includes("?"), false);
  for (const name of ["timestamp", "recvWindow", "signature"]) {
    assert.equal(queryOf(call.url).get(name), null);
  }
  // The API key header rides on every request, signed or not; Binance accepts it
  // on public endpoints and the client has no reason to branch on it.
  assert.equal(apiKeyHeader(call), "exec-test-key");
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test("a 429 is reported as rate limiting", async () => {
  const { fetchImpl } = fakeFetch(() => ({
    status: 429,
    body: JSON.stringify({ code: -1003, msg: "Too many requests; current limit is 6000." }),
  }));
  const client = new BinanceRest({ baseUrl: DEMO, credentials: CREDS, fetchImpl });

  await assert.rejects(client.account(), (err: unknown) => {
    assert.ok(err instanceof BinanceApiError);
    assert.match(err.message, /rate limited/);
    assert.match(err.message, /429/);
    assert.equal(err.status, 429);
    assert.equal(err.code, -1003);
    return true;
  });
});

test("a Binance error body surfaces its code and its message", async () => {
  const msg = "Account has insufficient balance for requested action.";
  const { fetchImpl } = fakeFetch(() => ({
    status: 400,
    body: JSON.stringify({ code: -2010, msg }),
  }));
  const client = new BinanceRest({ baseUrl: DEMO, credentials: CREDS, fetchImpl });

  await assert.rejects(
    client.newOrder({ symbol: "BNBUSDT", side: "BUY", type: "MARKET", quantity: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof BinanceApiError);
      assert.equal(err.code, -2010);
      assert.equal(err.status, 400);
      assert.match(err.message, /POST \/api\/v3\/order/);
      assert.ok(err.message.includes(msg), `message lost the exchange's own text: ${err.message}`);
      return true;
    },
  );
});

test("a non-JSON error body is reported as the text that came back", async () => {
  const { fetchImpl } = fakeFetch(() => ({
    status: 502,
    body: "<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>",
  }));
  const client = new BinanceRest({ baseUrl: DEMO, credentials: CREDS, fetchImpl });

  await assert.rejects(client.account(), (err: unknown) => {
    assert.ok(err instanceof BinanceApiError);
    assert.equal(err.status, 502);
    assert.equal(err.code, null);
    assert.match(err.message, /502 Bad Gateway/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

test("syncClock learns an offset and every later timestamp carries it", async () => {
  const OFFSET_MS = 3_600_000;
  const { fetchImpl, calls } = fakeFetch((url) =>
    url.includes("/api/v3/time")
      ? { body: JSON.stringify({ serverTime: Date.now() + OFFSET_MS }) }
      : { body: "[]" },
  );
  const client = new BinanceRest({ baseUrl: DEMO, credentials: CREDS, fetchImpl });

  const offset = await client.syncClock();
  assert.ok(
    Math.abs(offset - OFFSET_MS) < 1000,
    `offset ${offset} is not the hour the canned server time was ahead by`,
  );

  await client.myTrades("BNBUSDT", 424242);

  const timestamp = Number(queryOf(calls[1]!.url).get("timestamp"));
  assert.ok(
    Math.abs(timestamp - (Date.now() + OFFSET_MS)) < 1000,
    `timestamp ${timestamp} was sent on the local clock, so the offset was not applied`,
  );
});

// ---------------------------------------------------------------------------
// Waiting for a terminal state
// ---------------------------------------------------------------------------

test("awaitTerminal returns on the first read when the order is already FILLED", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ body: JSON.stringify(rawOrder()) }));
  const client = new BinanceRest({ baseUrl: DEMO, credentials: CREDS, fetchImpl });

  const order = await client.awaitTerminal("BNBUSDT", 424242, { pollMs: 5, timeoutMs: 2000 });

  assert.equal(order.status, "FILLED");
  assert.equal(calls.length, 1);
});

test("awaitTerminal polls until the order stops moving", async () => {
  const states = ["NEW", "PARTIALLY_FILLED", "FILLED"];
  const { fetchImpl, calls } = fakeFetch((_url, index) => ({
    body: JSON.stringify(
      rawOrder({
        status: states[index] ?? "FILLED",
        executedQty: index === 0 ? "0.00000000" : index === 1 ? "0.80000000" : "2.00000000",
      }),
    ),
  }));
  const client = new BinanceRest({ baseUrl: DEMO, credentials: CREDS, fetchImpl });

  const order = await client.awaitTerminal("BNBUSDT", 424242, { pollMs: 5, timeoutMs: 2000 });

  assert.equal(order.status, "FILLED");
  assert.equal(order.executedQty, "2.00000000");
  assert.equal(calls.length, 3);
});

test("awaitTerminal names the order it could not resolve", async () => {
  const { fetchImpl } = fakeFetch(() => ({
    body: JSON.stringify(rawOrder({ status: "NEW", executedQty: "0.00000000" })),
  }));
  const client = new BinanceRest({ baseUrl: DEMO, credentials: CREDS, fetchImpl });

  await assert.rejects(
    client.awaitTerminal("BNBUSDT", 424242, { pollMs: 5, timeoutMs: 25 }),
    (err: unknown) => {
      assert.ok(err instanceof BinanceApiError);
      assert.match(err.message, /Order 424242 on BNBUSDT is still NEW/);
      // The distinction the message exists to make: unresolved, not failed.
      assert.match(err.message, /unresolved/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Turning an order plus its trades into a confirmed fill
// ---------------------------------------------------------------------------

test("a filled order averages its price over the quantity that traded", () => {
  const fill = toConfirmedFill(rawOrder(), [rawTrade()], FILTERS);

  assert.equal(fill.status, "FILLED");
  assert.equal(fill.venue, "BINANCE_SPOT");
  assert.equal(fill.filledBaseQty, 2);
  assert.equal(fill.filledQuoteQty, 1505.5);
  assert.equal(fill.avgPrice, 1505.5 / 2);
  assert.equal(fill.reference, "424242");
  assert.match(fill.confirmedBy, /GET \/api\/v3\/order plus 1 trade record/);
});

test("commission charged in one asset is summed across the trades", () => {
  const fill = toConfirmedFill(
    rawOrder(),
    [
      rawTrade({ id: 1, qty: "1.20000000", commission: "0.00090000" }),
      rawTrade({ id: 2, qty: "0.80000000", commission: "0.00060000" }),
    ],
    FILTERS,
  );

  assert.equal(fill.fees.length, 1);
  assert.equal(fill.fees[0]!.asset, "BNB");
  assert.ok(
    Math.abs(fill.fees[0]!.amount - 0.0015) < 1e-12,
    `expected the two commissions to add up, got ${fill.fees[0]!.amount}`,
  );
});

test("commissions in different assets are all carried, never reduced to one", () => {
  const fill = toConfirmedFill(
    rawOrder(),
    [
      rawTrade({ id: 1, commissionAsset: "BNB", commission: "0.00200000" }),
      rawTrade({ id: 2, commissionAsset: "USDT", commission: "0.90000000" }),
    ],
    FILTERS,
  );

  assert.equal(fill.fees.length, 2, "both assets survive");
  const bnb = fill.fees.find((f) => f.asset === "BNB")!;
  const usdt = fill.fees.find((f) => f.asset === "USDT")!;
  assert.equal(bnb.amount, 0.002);
  assert.equal(usdt.amount, 0.9);
});

test("a fee in the base asset is priced at the fill price, not compared raw", () => {
  // 0.002 BNB at ~752 is about $1.50, so it outweighs 0.90 USDT despite being
  // the smaller raw number. Picking by magnitude across assets got this wrong.
  const fill = toConfirmedFill(
    rawOrder(),
    [
      rawTrade({ id: 1, commissionAsset: "BNB", commission: "0.00200000" }),
      rawTrade({ id: 2, commissionAsset: "USDT", commission: "0.90000000" }),
    ],
    FILTERS,
  );

  const bnb = fill.fees.find((f) => f.asset === "BNB")!;
  assert.ok(bnb.valueInQuote !== null, "a base-asset fee is priceable from the fill");
  assert.ok(
    bnb.valueInQuote! > 0.9,
    `0.002 BNB should be worth more than 0.90 USDT, got ${bnb.valueInQuote}`,
  );
  assert.ok(
    Math.abs(fill.totalFeeInQuote! - (0.9 + bnb.valueInQuote!)) < 1e-9,
    "the total is the sum of both, not the larger of them",
  );
});

test("a fee in an asset that is neither leg is reported unpriced, not as zero", () => {
  const fill = toConfirmedFill(
    rawOrder(),
    [rawTrade({ id: 1, commissionAsset: "TUSD", commission: "0.50000000" })],
    FILTERS,
  );

  assert.equal(fill.fees[0]!.asset, "TUSD");
  assert.equal(fill.fees[0]!.amount, 0.5);
  assert.equal(fill.fees[0]!.valueInQuote, null, "unknown rate is null, never 0");
  assert.equal(fill.totalFeeInQuote, null, "nothing priceable means no total to claim");
});

test("isMaker is null when the trades disagree about it", () => {
  const fill = toConfirmedFill(
    rawOrder(),
    [rawTrade({ id: 1, isMaker: true }), rawTrade({ id: 2, isMaker: false })],
    FILTERS,
  );

  assert.equal(fill.isMaker, null);
});

test("isMaker is the flag itself when every trade agrees", () => {
  const maker = toConfirmedFill(
    rawOrder(),
    [rawTrade({ id: 1, isMaker: true }), rawTrade({ id: 2, isMaker: true })],
    FILTERS,
  );
  const taker = toConfirmedFill(rawOrder(), [rawTrade({ isMaker: false })], FILTERS);

  assert.equal(maker.isMaker, true);
  assert.equal(taker.isMaker, false);
});

test("an EXPIRED order that partly filled is a partial fill, not a failure", () => {
  const fill = toConfirmedFill(
    rawOrder({
      status: "EXPIRED",
      origQty: "2.00000000",
      executedQty: "0.75000000",
      cummulativeQuoteQty: "564.56250000",
    }),
    [rawTrade({ qty: "0.75000000", quoteQty: "564.56250000" })],
    FILTERS,
  );

  assert.equal(fill.status, "PARTIAL");
  assert.equal(fill.filledBaseQty, 0.75);
  assert.equal(fill.avgPrice, 564.5625 / 0.75);
});

test("a CANCELED order that never filled is a failure", () => {
  const fill = toConfirmedFill(
    rawOrder({
      status: "CANCELED",
      executedQty: "0.00000000",
      cummulativeQuoteQty: "0.00000000",
    }),
    [],
    FILTERS,
  );

  assert.equal(fill.status, "FAILED");
  assert.equal(fill.avgPrice, 0);
  // No trades means no commission was charged at all, which is a genuine zero
  // rather than an unpriceable one.
  assert.deepEqual(fill.fees, []);
  assert.equal(fill.totalFeeInQuote, 0);
  assert.equal(fill.isMaker, null);
});

// ---------------------------------------------------------------------------
// Locating the wallet CLI
// ---------------------------------------------------------------------------

test("resolveCli honours BAW_BIN", () => {
  const restore = saveEnv(["BAW_BIN"]);
  try {
    process.env.BAW_BIN = "/opt/wallet/baw";
    assert.deepEqual(resolveCli(), { command: "/opt/wallet/baw", prefix: [] });
    // An explicit argument beats the environment.
    assert.deepEqual(resolveCli("/opt/wallet/pinned"), {
      command: "/opt/wallet/pinned",
      prefix: [],
    });
  } finally {
    restore();
  }
});

test("resolveCli returns a command and a prefix when BAW_BIN is unset", () => {
  const restore = saveEnv(["BAW_BIN"]);
  try {
    delete process.env.BAW_BIN;
    const cli = resolveCli();

    assert.equal(typeof cli.command, "string");
    assert.ok(cli.command.length > 0);
    assert.ok(Array.isArray(cli.prefix));
    // Either the package entry point run under this Node, or the bare name on
    // PATH. Both are locate-only: neither is spawned here.
    assert.ok(
      (cli.command === process.execPath && cli.prefix.length === 1) ||
        (cli.command === "baw" && cli.prefix.length === 0),
      `unexpected resolution: ${JSON.stringify(cli)}`,
    );
  } finally {
    restore();
  }
});

test("an odd round trip does not make the timestamp fractional", async (t) => {
  // The bug this pins: `serverTime - (before + rtt / 2)` is fractional whenever
  // the round trip is an odd number of milliseconds, and the timestamp then
  // serialises as "1757337600123.5". Binance matches the parameter against
  // ^[0-9]{1,20}$ and rejects it, so roughly half of all orders failed on
  // nothing but network timing.
  t.mock.timers.enable({ apis: ["Date"], now: 1_757_337_600_000 });
  const { fetchImpl, calls } = fakeFetch((url) => {
    if (url.includes("/api/v3/time")) {
      t.mock.timers.tick(1); // one millisecond: the round trip is odd
      return { body: JSON.stringify({ serverTime: 1_757_337_600_500 }) };
    }
    return { body: "[]" };
  });
  const client = new BinanceRest({ baseUrl: DEMO, credentials: CREDS, fetchImpl });

  const offset = await client.syncClock();
  assert.ok(Number.isInteger(offset), `the offset must be whole milliseconds, got ${offset}`);

  await client.myTrades("BNBUSDT", 424242);
  const timestamp = queryOf(calls[1]!.url).get("timestamp")!;
  assert.match(
    timestamp,
    /^[0-9]{1,20}$/,
    `Binance parses timestamp as ^[0-9]{1,20}$ and would reject "${timestamp}"`,
  );
});

test("the timestamp stays whole even if the offset somehow is not", async (t) => {
  // Belt and braces: the value the exchange parses is rounded where it is
  // built, not only where the offset is computed.
  t.mock.timers.enable({ apis: ["Date"], now: 1_757_337_600_000 });
  const { fetchImpl, calls } = fakeFetch((url) =>
    url.includes("/api/v3/time")
      ? { body: JSON.stringify({ serverTime: 1_757_337_600_501 }) }
      : { body: "[]" },
  );
  const client = new BinanceRest({ baseUrl: DEMO, credentials: CREDS, fetchImpl });
  await client.syncClock();
  await client.myTrades("BNBUSDT", 1);
  assert.match(queryOf(calls[1]!.url).get("timestamp")!, /^[0-9]{1,20}$/);
});
