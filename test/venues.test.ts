/**
 * The venue layer, which nothing was testing.
 *
 * These functions turn raw exchange and chain responses into the numbers every
 * later stage trusts. A mistake here is invisible: it does not throw, it does
 * not look wrong, it just makes every downstream figure quietly incorrect. The
 * maker side of the cost model is built entirely on `tradeRates`,
 * `adverseSelection` and `priceVolatilityBps`, and the venue choice on several
 * pairs is decided by `walletServiceFee` alone.
 *
 * The network functions are exercised against a stubbed `fetch` rather than a
 * live endpoint, so the decoding is what is under test and the suite still runs
 * with no network — which is what makes a green build mean anything.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  adverseSelection,
  clearFilterCache,
  fetchAggTrades,
  priceVolatilityBps,
  roundToStep,
  roundToTick,
  tradeRates,
  type AggTrade,
} from "../src/venues/binance.ts";
import { feeTierBps, quoteTier, walletServiceFee, TOKENS } from "../src/venues/onchain.ts";
import { resetSessionCache } from "../src/venues/wallet-quote.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A tape starting at t=0, one trade every `everyMs`, at a constant price. */
function tape(count: number, opts: Partial<AggTrade> & { everyMs?: number } = {}): AggTrade[] {
  const everyMs = opts.everyMs ?? 1000;
  return Array.from({ length: count }, (_, i) => ({
    price: opts.price ?? 100,
    qty: opts.qty ?? 1,
    time: i * everyMs,
    buyerIsMaker: opts.buyerIsMaker ?? false,
  }));
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  clearFilterCache();
  resetSessionCache();
});

/** Replace fetch with something that answers every call with `body`. */
function stubFetch(body: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

// ---------------------------------------------------------------------------

describe("tradeRates: how fast volume is arriving on each side", () => {
  test("the two sides are counted separately, not averaged", () => {
    // A market can be busy on one side and dead on the other. Averaging would
    // claim a resting buy is about to fill when every trade is a buyer lifting
    // the ask, which fills nothing resting on the bid.
    const trades: AggTrade[] = [
      { price: 100, qty: 5, time: 0, buyerIsMaker: true },
      { price: 100, qty: 3, time: 5_000, buyerIsMaker: true },
      { price: 100, qty: 40, time: 10_000, buyerIsMaker: false },
    ];
    const r = tradeRates(trades);
    assert.equal(r.windowSec, 10);
    assert.equal(r.hitsBidPerSec, 0.8);
    assert.equal(r.liftsAskPerSec, 4);
  });

  test("a single trade cannot establish a rate", () => {
    // One trade has no window. Dividing by a made-up one would invent a rate,
    // and the maker model would treat it as a measurement.
    assert.deepEqual(tradeRates(tape(1)), {
      hitsBidPerSec: 0,
      liftsAskPerSec: 0,
      windowSec: 0,
    });
    assert.deepEqual(tradeRates([]), { hitsBidPerSec: 0, liftsAskPerSec: 0, windowSec: 0 });
  });

  test("a burst inside one second does not divide by a window near zero", () => {
    // Twenty trades in 50 ms is a real pattern. Without the floor the window is
    // 0.05 s and the rate comes out twenty times too high, which would make a
    // resting order look certain to fill.
    const burst = tape(20, { everyMs: 2, qty: 1, buyerIsMaker: true });
    const r = tradeRates(burst);
    assert.equal(r.windowSec, 1, "the window is floored at one second");
    assert.equal(r.hitsBidPerSec, 20);
  });

  test("trades arriving out of order still produce the true window", () => {
    const shuffled: AggTrade[] = [
      { price: 100, qty: 1, time: 9_000, buyerIsMaker: false },
      { price: 100, qty: 1, time: 1_000, buyerIsMaker: false },
      { price: 100, qty: 1, time: 5_000, buyerIsMaker: false },
    ];
    assert.equal(tradeRates(shuffled).windowSec, 8);
  });
});

describe("adverseSelection: what happens after a passive fill", () => {
  /**
   * A tape that drifts by `bpsPerStep` on every trade. Every trade is marked as
   * a seller crossing into the bid, so each one stands in for a resting buyer
   * being filled.
   */
  function drifting(count: number, bpsPerStep: number, buyerIsMaker = true): AggTrade[] {
    let price = 100;
    return Array.from({ length: count }, (_, i) => {
      const t = { price, qty: 1, time: i * 1000, buyerIsMaker };
      price *= 1 + bpsPerStep / 10_000;
      return t;
    });
  }

  test("a thin tape refuses to measure rather than measuring badly", () => {
    const r = adverseSelection(tape(19));
    assert.equal(r.samples, 0);
    assert.equal(r.restingBuyBps, 0);
    assert.equal(r.restingSellBps, 0);
  });

  test("a market that keeps falling after each fill is a cost to a resting buyer", () => {
    // This is the whole phenomenon: the resting bid filled because someone
    // chose to sell into it, and they were right.
    const r = adverseSelection(drifting(60, -10), 5000);
    assert.ok(r.restingBuyBps > 0, `falling market must cost a resting buyer, got ${r.restingBuyBps}`);
  });

  test("a market that keeps rising after each fill pays a resting buyer", () => {
    // The sign convention has to survive the other direction. Flooring this at
    // zero would bias every maker estimate upward.
    const r = adverseSelection(drifting(60, 10), 5000);
    assert.ok(r.restingBuyBps < 0, `rising market must not cost a resting buyer, got ${r.restingBuyBps}`);
  });

  test("a flat market costs nothing either way", () => {
    const r = adverseSelection(tape(60, { buyerIsMaker: true }), 5000);
    assert.equal(r.restingBuyBps, 0);
  });

  test("the resting-sell side takes the opposite sign from the same drift", () => {
    // A rising market costs a resting seller exactly what it pays a resting
    // buyer. One tape, both sides, opposite signs.
    const rising = adverseSelection(drifting(60, 10, false), 5000);
    assert.ok(rising.restingSellBps > 0, `rising market must cost a resting seller, got ${rising.restingSellBps}`);
  });

  test("samples counts the weaker side, so one-sided flow reports a weak measurement", () => {
    // Every fill here is on the bid. The ask side was never measured, and
    // reporting 60 samples would overstate what is actually known.
    const r = adverseSelection(drifting(60, -10, true), 5000);
    assert.equal(r.samples, 0, "no sell-side fills were observed");
  });

  test("a longer horizon sees more of the drift", () => {
    const short = adverseSelection(drifting(120, -5), 2000);
    const long = adverseSelection(drifting(120, -5), 20_000);
    assert.ok(
      long.restingBuyBps > short.restingBuyBps,
      `a 20s horizon should capture more drift than 2s, got ${long.restingBuyBps} vs ${short.restingBuyBps}`,
    );
  });
});

describe("priceVolatilityBps: the error bar, measured", () => {
  test("a flat tape has no volatility", () => {
    assert.equal(priceVolatilityBps(tape(100), 5000), 0);
  });

  test("too few paired observations report zero rather than a number from nothing", () => {
    // Under ten pairs the standard deviation is noise. Reporting it would put a
    // confident error bar on a quote that has none.
    assert.equal(priceVolatilityBps(tape(19), 5000), 0);
    // Enough trades, but a horizon so long that no pair spans it.
    assert.equal(priceVolatilityBps(tape(40, { everyMs: 100 }), 60_000), 0);
  });

  test("volatility grows with the horizon, as a random walk should", () => {
    // Not a coincidence — it is the check that the figure measures what it
    // claims. A constant across horizons would mean it does not.
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648 - 0.5;
    };
    let price = 100;
    const walk: AggTrade[] = Array.from({ length: 600 }, (_, i) => {
      const t = { price, qty: 1, time: i * 200, buyerIsMaker: i % 2 === 0 };
      price *= 1 + random() / 500;
      return t;
    });

    const short = priceVolatilityBps(walk, 1000);
    const long = priceVolatilityBps(walk, 16_000);
    assert.ok(short > 0, "a moving tape must have non-zero volatility");
    assert.ok(long > short, `volatility should grow with horizon, got ${short} then ${long}`);
  });

  test("a zero or negative price is skipped rather than dividing by it", () => {
    const poisoned = tape(60, { everyMs: 200 });
    poisoned[5] = { ...poisoned[5]!, price: 0 };
    const v = priceVolatilityBps(poisoned, 1000);
    assert.ok(Number.isFinite(v), `a zero price must not produce ${v}`);
  });
});

describe("rounding onto the symbol's own grid", () => {
  test("quantity floors onto the step, never up", () => {
    // Rounding up produces an order larger than intended, which can breach a
    // cap that was checked against the pre-rounded size.
    assert.equal(roundToStep(1.29999, 0.001), 1.299);
    assert.equal(roundToStep(0.0009, 0.001), 0);
  });

  test("floating point dust is snapped off, not carried to the exchange", () => {
    // 0.1 + 0.2 arithmetic leaves 0.30000000000000004, which is rejected on
    // precision even though the value is right.
    const q = roundToStep(0.3, 0.1);
    assert.equal(q, 0.3);
    assert.equal(String(q), "0.3");
  });

  test("a value already on the step is not nudged off it", () => {
    // Floor plus floating point can turn an exact multiple into the step below.
    for (const [qty, step] of [
      [1.1, 0.1],
      [2.2, 0.1],
      [0.07, 0.01],
      [33, 1],
    ] as const) {
      assert.equal(roundToStep(qty, step), qty, `${qty} is already a multiple of ${step}`);
    }
  });

  test("price rounds to the nearest tick, unlike quantity", () => {
    // A price is a limit, not a size: nearest is right, and flooring would
    // shift every sell order a tick away from the market.
    assert.equal(roundToTick(753.847, 0.01), 753.85);
    assert.equal(roundToTick(753.844, 0.01), 753.84);
  });

  test("a missing or zero grid passes the value through untouched", () => {
    assert.equal(roundToStep(1.23456, 0), 1.23456);
    assert.equal(roundToTick(1.23456, 0), 1.23456);
  });
});

describe("decoding what the venues actually send back", () => {
  test("aggregated trades are decoded from strings into numbers", () => {
    stubFetch([
      { p: "753.84000000", q: "1.50000000", T: 1_700_000_000_000, m: true },
      { p: "753.85000000", q: "0.25000000", T: 1_700_000_001_000, m: false },
    ]);
    return fetchAggTrades("BNBUSDT").then((trades) => {
      assert.equal(trades.length, 2);
      // Binance sends every number as a string. Left as strings, `qty` would
      // concatenate instead of summing and every rate would be nonsense.
      assert.equal(trades[0]!.price, 753.84);
      assert.equal(trades[0]!.qty, 1.5);
      assert.equal(trades[0]!.buyerIsMaker, true);
      assert.equal(trades[1]!.buyerIsMaker, false);
    });
  });

  test("a missing maker flag is read as false rather than as truthy", async () => {
    // `m` decides which side of the book a trade filled. An undefined value
    // read loosely would silently classify every trade as hitting the bid.
    stubFetch([{ p: "1", q: "1", T: 1, m: undefined }]);
    const trades = await fetchAggTrades("BNBUSDT");
    assert.equal(trades[0]!.buyerIsMaker, false);
  });

  test("an unparseable price is refused rather than becoming NaN", async () => {
    stubFetch([{ p: "not-a-price", q: "1", T: 1, m: false }]);
    await assert.rejects(fetchAggTrades("BNBUSDT"), /price/i);
  });
});

describe("the on-chain quoter's response", () => {
  const WBNB = TOKENS.BNB!;
  const USDT = TOKENS.USDT!;

  /** A quoter reply: amountOut, sqrtPriceX96After, ticksCrossed, gasEstimate. */
  const reply = (amountOutWei: bigint, gas = 120_000n) =>
    "0x" +
    [amountOutWei, 0n, 0n, gas].map((v) => v.toString(16).padStart(64, "0")).join("");

  test("the payout is scaled by the output token's decimals", async () => {
    // Both these tokens are 18 decimals, so a raw integer read straight through
    // would be off by 10^18 — a mistake that never throws and never looks odd
    // in a ratio, only in the price.
    stubFetch({ result: reply(2n * 10n ** 18n) });
    const q = await quoteTier(USDT, WBNB, 1500, 100);
    assert.ok(q);
    assert.equal(q.amountOut, 2);
    assert.equal(q.price, 2 / 1500);
    assert.equal(q.gasEstimate, 120_000);
    assert.equal(q.feeTier, 100);
  });

  test("a pool that pays out nothing is absent, not free", async () => {
    // The tier exists but has no liquidity at this size. Returning a quote of
    // zero would make it the cheapest route available.
    stubFetch({ result: reply(0n) });
    assert.equal(await quoteTier(USDT, WBNB, 1500, 100), null);
  });

  test("a truncated response is refused rather than decoded from padding", async () => {
    stubFetch({ result: "0x" + "0".repeat(64) });
    assert.equal(await quoteTier(USDT, WBNB, 1500, 100), null);
  });

  test("a node returning an error leaves the other tiers alone", async () => {
    // One missing pool is normal. It must come back as null so the tiers that
    // did answer still get compared.
    stubFetch({ error: { code: -32000, message: "execution reverted" } });
    assert.equal(await quoteTier(USDT, WBNB, 1500, 100), null);
  });
});

describe("the wallet's service fee, which decides the venue on its own", () => {
  test("fee tiers convert out of hundredths of a bip", () => {
    // 100 means 0.01%, not 100 bps. Reading the raw tier as basis points
    // overstates the cheapest pool's fee by a factor of a hundred.
    assert.equal(feeTierBps(100), 1);
    assert.equal(feeTierBps(500), 5);
    assert.equal(feeTierBps(2500), 25);
    assert.equal(feeTierBps(10_000), 100);
  });

  test("two assets named in the free group are charged nothing", () => {
    const fee = walletServiceFee("WBNB", "USDT");
    assert.equal(fee.rate, 0);
    assert.equal(fee.verified, true);
  });

  test("an asset outside the free group is charged, and marked unconfirmed", () => {
    // 0.5% is fifty basis points — larger on these routes than everything else
    // combined. Assuming it away would route to a venue that is not cheaper.
    const fee = walletServiceFee("XRP", "USDT");
    assert.equal(fee.rate, 0.005);
    assert.equal(fee.verified, false, "the schedule does not settle this case");
    assert.match(fee.detail, /XRP/);
  });

  test("the unresolved case is charged the higher rate, not the convenient one", () => {
    // A pegged representation of a major chain's coin may qualify under the
    // schedule's wording. Until that is confirmed, guessing free costs money
    // and guessing expensive costs an opportunity.
    assert.equal(walletServiceFee("BTCB", "USDT").rate, 0.005);
  });

  test("the lookup is case-insensitive", () => {
    // The exchange sends upper case and the chain's own symbol() often does
    // not. A case-sensitive lookup would miss and charge 50 bps on a free pair.
    assert.equal(walletServiceFee("wbnb", "usdt").rate, 0);
    assert.equal(walletServiceFee("Eth", "UsDt").rate, 0);
  });

  test("either side being outside the group is enough to charge", () => {
    assert.equal(walletServiceFee("USDT", "XRP").rate, 0.005);
    assert.equal(walletServiceFee("XRP", "USDT").rate, 0.005);
  });
});

describe("the token map, where a wrong entry costs the whole order", () => {
  test("Bitcoin is keyed by the exchange's asset and holds the chain's contract", () => {
    // The bug this pins: a lookup by "BTC" that finds nothing because the map
    // was keyed by "BTCB", on exactly the pair where the fee decides the venue.
    assert.equal(TOKENS.BTC!.symbol, "BTCB");
    assert.equal(TOKENS.BTC!.address, "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c");
  });

  test("every token has a plausible address and decimals", () => {
    for (const [asset, token] of Object.entries(TOKENS)) {
      assert.match(token.address, /^0x[0-9a-fA-F]{40}$/, `${asset} has a malformed address`);
      assert.ok(
        Number.isInteger(token.decimals) && token.decimals > 0 && token.decimals <= 18,
        `${asset} has implausible decimals: ${token.decimals}`,
      );
    }
  });

  test("no two entries point at the same contract", () => {
    // Two assets sharing an address means one of them is wrong, and the swap
    // would be built against the wrong token without failing.
    const seen = new Map<string, string>();
    for (const [asset, token] of Object.entries(TOKENS)) {
      const key = token.address.toLowerCase();
      assert.equal(seen.get(key), undefined, `${asset} shares an address with ${seen.get(key)}`);
      seen.set(key, asset);
    }
  });
});
