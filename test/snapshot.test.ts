import { test } from "node:test";
import assert from "node:assert/strict";

import { depthWithin, hashSnapshot, queueAhead, walkBook } from "../src/snapshot.ts";
import type { BookLevel, OnchainQuote, OrderBook, Snapshot, WalletQuote } from "../src/types.ts";

// BNBUSDT on a quiet afternoon: a two-cent spread, ten levels a side, five BNB
// resting on each. The ladder is deliberately regular so every expected number
// below can be worked out by hand and checked without running the code.
const MID = 752;
const BEST_BID = 751.99;
const BEST_ASK = 752.01;
const TICK = 0.01;
const LEVEL_QTY = 5;
const TAKEN_AT = 1_757_337_600_000;

/** Walking a book multiplies and divides, so exact equality is the wrong test. */
function closeTo(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

function makeBook(shape: { levels?: number; bidQty?: number; askQty?: number } = {}): OrderBook {
  const levels = shape.levels ?? 10;
  const bids: BookLevel[] = [];
  const asks: BookLevel[] = [];
  for (let i = 0; i < levels; i++) {
    // toFixed keeps the ladder on the tick: 751.99 - 3 * 0.01 is 751.95999...
    bids.push({ price: Number((BEST_BID - i * TICK).toFixed(2)), qty: shape.bidQty ?? LEVEL_QTY });
    asks.push({ price: Number((BEST_ASK + i * TICK).toFixed(2)), qty: shape.askQty ?? LEVEL_QTY });
  }
  return { bids, asks, lastUpdateId: 81_004_422 };
}

/** The standard book with one ask level replaced, for the hash mutation table. */
function bookWithAsk(index: number, level: BookLevel): OrderBook {
  const book = makeBook();
  book.asks[index] = level;
  return book;
}

function makeOnchain(): OnchainQuote {
  const best = { feeTier: 500, amountOut: 9.9812, price: 0.0013273, gasEstimate: 121_400 };
  return {
    chainId: 56,
    tokenIn: "0x55d398326f99059fF775485246999027B3197955",
    tokenOut: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    amountIn: 7520,
    tiers: [best, { feeTier: 2500, amountOut: 9.9642, price: 0.001325, gasEstimate: 121_400 }],
    best,
    gasPriceWei: 1_000_000_000,
    gasCostUsd: 0.1366,
    referencePrice: 0.001329,
    walletQuote: null,
  };
}

function makeSnapshot(over: Partial<Omit<Snapshot, "hash">> = {}): Omit<Snapshot, "hash"> {
  return {
    symbol: "BNBUSDT",
    takenAt: TAKEN_AT,
    mid: MID,
    bestBid: BEST_BID,
    bestAsk: BEST_ASK,
    spreadBps: ((BEST_ASK - BEST_BID) / MID) * 10_000,
    book: makeBook(),
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
    commission: { maker: 0.001, taker: 0.001, source: "vip0-default" },
    flow: { hitsBidPerSec: 3, liftsAskPerSec: 3, windowSec: 60, adverseBuyBps: 0.6, adverseSellBps: 0.5, adverseSamples: 400, volExchangeBps: 1.5, volSettlementBps: 1.8 },
    onchain: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// walkBook
// ---------------------------------------------------------------------------

test("walkBook fills entirely on the touch when the size fits there", () => {
  const walk = walkBook(makeBook(), "BUY", 3);

  closeTo(walk.avgPrice, BEST_ASK);
  assert.equal(walk.filled, 3);
  assert.equal(walk.levelsUsed, 1);
  assert.equal(walk.exhausted, false);
});

test("walkBook weights the average by the quantity taken from each level", () => {
  // 5 @ 752.01 = 3760.05, 5 @ 752.02 = 3760.10, 2 @ 752.03 = 1504.06.
  // 9024.21 spent on 12 BNB is 752.0175 average.
  const walk = walkBook(makeBook(), "BUY", 12);

  closeTo(walk.avgPrice, 752.0175);
  assert.equal(walk.filled, 12);
  assert.equal(walk.levelsUsed, 3);
  assert.equal(walk.exhausted, false);
});

test("walkBook reports exhausted rather than pretending a thin book filled the order", () => {
  // Ten levels of 5 BNB is 50 in total, against a request for 100.
  const walk = walkBook(makeBook(), "BUY", 100);

  assert.equal(walk.exhausted, true);
  assert.equal(walk.filled, 50);
  assert.equal(walk.levelsUsed, 10);
  // Average of 752.01 through 752.10, since every level was consumed whole.
  closeTo(walk.avgPrice, 752.055);
});

test("walkBook on an empty side fills nothing and prices nothing", () => {
  const walk = walkBook({ bids: [], asks: [], lastUpdateId: 1 }, "BUY", 4);

  assert.equal(walk.filled, 0);
  assert.equal(walk.avgPrice, 0);
  assert.equal(walk.levelsUsed, 0);
  assert.equal(walk.exhausted, true);
});

test("walkBook walks the bids for a SELL, not the asks", () => {
  // 5 @ 751.99 + 5 @ 751.98 + 2 @ 751.97 = 9023.79 over 12 BNB, so 751.9825.
  const sell = walkBook(makeBook(), "SELL", 12);
  const buy = walkBook(makeBook(), "BUY", 12);

  closeTo(sell.avgPrice, 751.9825);
  assert.ok(sell.avgPrice < MID, "a sell fills below mid");
  assert.ok(buy.avgPrice > MID, "a buy fills above mid");
  assert.notEqual(sell.avgPrice, buy.avgPrice);
});

test("walkBook counts a level it consumes exactly, and no level beyond it", () => {
  const twoWhole = walkBook(makeBook(), "BUY", 10);
  assert.equal(twoWhole.levelsUsed, 2);
  assert.equal(twoWhole.exhausted, false);

  // One thousandth more reaches into the third level.
  const spillover = walkBook(makeBook(), "BUY", 10.001);
  assert.equal(spillover.levelsUsed, 3);
  assert.equal(spillover.exhausted, false);
});

test("walkBook stops at the size asked for however deep the book runs", () => {
  const deep = walkBook(makeBook({ levels: 40 }), "BUY", 5);

  assert.equal(deep.levelsUsed, 1);
  assert.equal(deep.filled, 5);
  assert.equal(deep.exhausted, false);
});

// ---------------------------------------------------------------------------
// depthWithin
// ---------------------------------------------------------------------------

test("depthWithin counts only the levels inside the window", () => {
  // 0.5 bps of 752 is 3.76 cents, so the window closes at 752.0376 and the
  // first three asks qualify: 5 * (752.01 + 752.02 + 752.03) = 11280.30.
  closeTo(depthWithin(makeBook(), "BUY", MID, 0.5), 11280.3, 1e-6);
});

test("depthWithin measures bids for a SELL and asks for a BUY", () => {
  // Mirror of the BUY window: it opens at 751.9624, so 751.99, 751.98, 751.97.
  closeTo(depthWithin(makeBook(), "SELL", MID, 0.5), 11279.7, 1e-6);

  // With different sizes resting on each side the two answers must differ.
  const lopsided = makeBook({ bidQty: 2, askQty: 8 });
  const buy = depthWithin(lopsided, "BUY", MID, 0.5);
  const sell = depthWithin(lopsided, "SELL", MID, 0.5);
  assert.ok(buy > sell, `expected the ask side to hold more, got ${buy} against ${sell}`);
});

test("depthWithin stops at the first level outside the window", () => {
  // A real book is sorted, so the function is entitled to stop rather than
  // filter. This proves it does: the level past the gap is never counted even
  // though its price sits inside the window.
  const gapped: OrderBook = {
    bids: [],
    asks: [
      { price: 752.01, qty: 5 },
      { price: 900, qty: 5 },
      { price: 752.02, qty: 5 },
    ],
    lastUpdateId: 1,
  };

  closeTo(depthWithin(gapped, "BUY", MID, 0.5), 752.01 * 5, 1e-6);
});

test("depthWithin returns nothing when the window closes at mid", () => {
  assert.equal(depthWithin(makeBook(), "BUY", MID, 0), 0);
  assert.equal(depthWithin(makeBook(), "SELL", MID, 0), 0);
});

test("depthWithin counts the whole visible side when the window is wide", () => {
  // 100 bps reaches well past the tenth level on either side.
  const everything = makeBook().asks.reduce((a, l) => a + l.price * l.qty, 0);

  closeTo(depthWithin(makeBook(), "BUY", MID, 100), everything, 1e-6);
});

// ---------------------------------------------------------------------------
// queueAhead
// ---------------------------------------------------------------------------

test("queueAhead reads the top of the side the resting order would join", () => {
  const book = makeBook({ bidQty: 7, askQty: 3 });

  // A resting buy joins the bid queue; a resting sell joins the ask queue.
  assert.equal(queueAhead(book, "BUY"), 7);
  assert.equal(queueAhead(book, "SELL"), 3);
});

test("queueAhead ignores everything behind the touch", () => {
  const book: OrderBook = {
    bids: [
      { price: 751.99, qty: 4 },
      { price: 751.98, qty: 900 },
    ],
    asks: [{ price: 752.01, qty: 6 }],
    lastUpdateId: 1,
  };

  assert.equal(queueAhead(book, "BUY"), 4);
});

test("queueAhead is zero on an empty side", () => {
  assert.equal(queueAhead({ bids: [], asks: [], lastUpdateId: 1 }, "BUY"), 0);
});

// ---------------------------------------------------------------------------
// hashSnapshot
// ---------------------------------------------------------------------------

test("hashSnapshot gives one hash to two separately built identical snapshots", () => {
  assert.equal(hashSnapshot(makeSnapshot()), hashSnapshot(makeSnapshot()));
  assert.match(hashSnapshot(makeSnapshot()), /^[0-9a-f]{16}$/);
});

test("hashSnapshot changes when any hashed input changes", () => {
  const base = hashSnapshot(makeSnapshot());
  const filters = makeSnapshot().filters;

  const mutations: [string, Omit<Snapshot, "hash">][] = [
    ["symbol", makeSnapshot({ symbol: "ETHUSDT" })],
    ["takenAt", makeSnapshot({ takenAt: TAKEN_AT + 1 })],
    ["bestBid", makeSnapshot({ bestBid: 751.98 })],
    ["bestAsk", makeSnapshot({ bestAsk: 752.02 })],
    ["lastUpdateId", makeSnapshot({ book: { ...makeBook(), lastUpdateId: 81_004_423 } })],
    ["a top-of-book price", makeSnapshot({ book: bookWithAsk(0, { price: 752.02, qty: LEVEL_QTY }) })],
    ["a top-of-book quantity", makeSnapshot({ book: bookWithAsk(0, { price: BEST_ASK, qty: 6 }) })],
    ["a level deep in the book", makeSnapshot({ book: bookWithAsk(9, { price: 752.1, qty: 5.5 }) })],
    ["stepSize", makeSnapshot({ filters: { ...filters, stepSize: 0.01 } })],
    ["tickSize", makeSnapshot({ filters: { ...filters, tickSize: 0.001 } })],
    ["minNotional", makeSnapshot({ filters: { ...filters, minNotional: 10 } })],
    [
      "the maker rate",
      makeSnapshot({ commission: { maker: 0.0009, taker: 0.001, source: "vip0-default" } }),
    ],
    [
      "the taker rate",
      makeSnapshot({ commission: { maker: 0.001, taker: 0.0009, source: "vip0-default" } }),
    ],
    [
      "where the commission came from",
      makeSnapshot({ commission: { maker: 0.001, taker: 0.001, source: "account" } }),
    ],
    ["hitsBidPerSec", makeSnapshot({ flow: { hitsBidPerSec: 3.5, liftsAskPerSec: 3, windowSec: 60, adverseBuyBps: 0.6, adverseSellBps: 0.5, adverseSamples: 400, volExchangeBps: 1.5, volSettlementBps: 1.8 } })],
    ["liftsAskPerSec", makeSnapshot({ flow: { hitsBidPerSec: 3, liftsAskPerSec: 3.5, windowSec: 60, adverseBuyBps: 0.6, adverseSellBps: 0.5, adverseSamples: 400, volExchangeBps: 1.5, volSettlementBps: 1.8 } })],
    ["the flow window", makeSnapshot({ flow: { hitsBidPerSec: 3, liftsAskPerSec: 3, windowSec: 61, adverseBuyBps: 0.6, adverseSellBps: 0.5, adverseSamples: 400, volExchangeBps: 1.5, volSettlementBps: 1.8 } })],
    ["an on-chain quote appearing", makeSnapshot({ onchain: makeOnchain() })],
  ];

  for (const [what, snapshot] of mutations) {
    assert.notEqual(hashSnapshot(snapshot), base, `${what} should change the hash`);
  }
});

test("hashSnapshot changes when the on-chain tiers, size or gas price change", () => {
  const base = hashSnapshot(makeSnapshot({ onchain: makeOnchain() }));
  const withTiers = (tiers: OnchainQuote["tiers"]): string =>
    hashSnapshot(makeSnapshot({ onchain: { ...makeOnchain(), tiers } }));

  const [first, second] = [makeOnchain().tiers[0]!, makeOnchain().tiers[1]!];

  assert.notEqual(withTiers([{ ...first, amountOut: 9.97 }, second]), base, "a tier's payout");
  assert.notEqual(withTiers([{ ...first, gasEstimate: 130_000 }, second]), base, "a tier's gas");
  assert.notEqual(withTiers([{ ...first, feeTier: 100 }, second]), base, "which tier answered");
  assert.notEqual(
    withTiers([first, second, { feeTier: 100, amountOut: 9.5, price: 0.00126, gasEstimate: 90_000 }]),
    base,
    "an extra tier answering",
  );

  const withAmountIn = makeSnapshot({ onchain: { ...makeOnchain(), amountIn: 7521 } });
  assert.notEqual(hashSnapshot(withAmountIn), base);
  assert.notEqual(
    hashSnapshot(makeSnapshot({ onchain: { ...makeOnchain(), gasPriceWei: 1_100_000_000 } })),
    base,
  );
});

test("hashSnapshot changes when the wallet's own quote appears or moves", () => {
  const base = hashSnapshot(makeSnapshot({ onchain: makeOnchain() }));
  const quoted = (walletQuote: WalletQuote): string =>
    hashSnapshot(makeSnapshot({ onchain: { ...makeOnchain(), walletQuote } }));

  // The second opinion on the price is part of what the decision may read, so
  // it has to be part of what the decision is replayed against.
  const wallet: WalletQuote = {
    fromSymbol: "USDT",
    toSymbol: "BNB",
    amountIn: 7520,
    amountOut: 9.9791,
    slippage: 0.005,
  };

  assert.notEqual(quoted(wallet), base, "a wallet quote arriving");
  assert.notEqual(quoted({ ...wallet, amountOut: 9.98 }), quoted(wallet), "a different payout");
  assert.notEqual(quoted({ ...wallet, amountIn: 7521 }), quoted(wallet), "a different input");
});

test("hashSnapshot does not depend on the order the keys were written in", () => {
  const ordered = makeSnapshot();

  // Same values, every object literal assembled back to front, including the
  // nested book and each of its levels.
  const shuffled: Omit<Snapshot, "hash"> = {
    onchain: null,
    flow: {
      adverseSamples: 400, volExchangeBps: 1.5, volSettlementBps: 1.8,
      adverseSellBps: 0.5,
      adverseBuyBps: 0.6,
      windowSec: 60,
      liftsAskPerSec: 3,
      hitsBidPerSec: 3,
    },
    commission: { source: "vip0-default", taker: 0.001, maker: 0.001 },
    filters: {
      minNotional: 5,
      tickSize: 0.01,
      maxQty: 9000,
      minQty: 0.001,
      stepSize: 0.001,
      quoteAssetPrecision: 8,
      baseAssetPrecision: 8,
      quoteAsset: "USDT",
      baseAsset: "BNB",
      symbol: "BNBUSDT",
    },
    book: {
      lastUpdateId: ordered.book.lastUpdateId,
      asks: ordered.book.asks.map((l) => ({ qty: l.qty, price: l.price })),
      bids: ordered.book.bids.map((l) => ({ qty: l.qty, price: l.price })),
    },
    spreadBps: ordered.spreadBps,
    bestAsk: BEST_ASK,
    bestBid: BEST_BID,
    mid: MID,
    takenAt: TAKEN_AT,
    symbol: "BNBUSDT",
  };

  assert.equal(hashSnapshot(shuffled), hashSnapshot(ordered));
});

test("hashSnapshot covers mid directly, not only through the touch prices", () => {
  // mid is read by resolveQty and by every cost function, so two snapshots that
  // differ only there must not share a hash. On the live path mid is derived
  // from the touch, but a snapshot rebuilt from storage or built by hand can
  // move it independently.
  assert.notEqual(hashSnapshot(makeSnapshot({ mid: 900 })), hashSnapshot(makeSnapshot()));

  // Moving the touch, which is how mid actually moves, changes it too.
  const wider = makeSnapshot({ bestBid: 751.5, bestAsk: 752.5 });
  assert.notEqual(hashSnapshot(wider), hashSnapshot(makeSnapshot()));
});

test("hashSnapshot covers the asset names, which decide the wallet fee", () => {
  // walletServiceFeeRate reads these and the answer is worth 50 bps, so they
  // cannot be left outside the hash.
  const renamed = makeSnapshot();
  renamed.filters = { ...renamed.filters, quoteAsset: "OTHERCOIN" };
  assert.notEqual(hashSnapshot(renamed), hashSnapshot(makeSnapshot()));
});
