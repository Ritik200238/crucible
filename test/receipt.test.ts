import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertLive, buildReceipt, execute, ExecutionError } from "../src/exec/execute.ts";
import { PLAN_TTL_MS, RouteError, assertExecutable } from "../src/decide/router.ts";
import { Ledger } from "../src/ledger/chain.ts";
import type {
  ConfirmedFill,
  CostEstimate,
  Plan,
  Policy,
  Snapshot,
} from "../src/types.ts";

// BNBUSDT at a mid of 752, so every basis point below is worth 0.0752 of a
// dollar per BNB and the expected numbers can be checked by hand.
const MID = 752;
const CREATED_AT = 1_757_337_600_000;
const SNAPSHOT_HASH = createHash("sha256").update("BNBUSDT@1757337600000").digest("hex");
const FINGERPRINT = SNAPSHOT_HASH.slice(0, 16);

/** Basis points are a division; exact equality is the wrong test for them. */
function closeTo(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

function snapshot(): Snapshot {
  return {
    symbol: "BNBUSDT",
    takenAt: CREATED_AT,
    mid: MID,
    bestBid: 751.99,
    bestAsk: 752.01,
    spreadBps: ((752.01 - 751.99) / MID) * 10_000,
    book: {
      bids: [
        { price: 751.99, qty: 5 },
        { price: 751.98, qty: 5 },
      ],
      asks: [
        { price: 752.01, qty: 5 },
        { price: 752.02, qty: 5 },
      ],
      lastUpdateId: 81_004_422,
    },
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
    commission: { maker: 0.001, taker: 0.001, source: "account" },
    flow: { hitsBidPerSec: 1.4, liftsAskPerSec: 1.6, windowSec: 20, adverseBuyBps: 0.6, adverseSellBps: 0.5, adverseSamples: 400 },
    onchain: null,
    hash: SNAPSHOT_HASH,
  };
}

/** The route the plan took: 5 bps of taker fee plus 2.5 bps of book impact. */
function chosenRoute(): CostEstimate {
  return {
    venue: "BINANCE_SPOT",
    style: "TAKER",
    components: [
      { name: "taker fee", bps: 5, detail: "0.05% of notional at this account's rate." },
      { name: "book impact", bps: 2.5, detail: "One BNB walks two levels of asks." },
    ],
    totalBps: 7.5,
    totalUsd: (7.5 / 10_000) * MID,
    effectivePrice: MID * (1 + 7.5 / 10_000),
    hasEstimates: false,
  };
}

/** The route it rejected, at 22 bps. */
function onchainRoute(over: Partial<CostEstimate> = {}): CostEstimate {
  return {
    venue: "ONCHAIN",
    style: "TAKER",
    components: [
      { name: "pool fee", bps: 5, detail: "0.05% tier." },
      { name: "pool impact", bps: 15, detail: "Against the pool's near-zero-size price." },
      { name: "gas", bps: 2, detail: "At 1 gwei." },
    ],
    totalBps: 22,
    totalUsd: (22 / 10_000) * MID,
    effectivePrice: MID * (1 + 22 / 10_000),
    hasEstimates: false,
    ...over,
  };
}

function plan(over: Partial<Plan> = {}): Plan {
  return {
    id: FINGERPRINT.slice(0, 12),
    fingerprint: FINGERPRINT,
    intent: { symbol: "BNBUSDT", side: "BUY", baseQty: 1 },
    snapshotHash: SNAPSHOT_HASH,
    createdAt: CREATED_AT,
    expiresAt: CREATED_AT + PLAN_TTL_MS,
    chosen: chosenRoute(),
    alternatives: [onchainRoute()],
    savingBps: 14.5,
    savingUsd: (14.5 / 10_000) * MID,
    baseQty: 1,
    quoteQty: MID,
    slices: [],
    rationale:
      "Binance spot at 7.50 bps beats on-chain at 22.00 bps, a saving of 14.50 bps.",
    ...over,
  };
}

function fill(over: Partial<ConfirmedFill> = {}): ConfirmedFill {
  return {
    venue: "BINANCE_SPOT",
    status: "FILLED",
    filledBaseQty: 1,
    filledQuoteQty: 752.752,
    avgPrice: 752.752,
    feeAsset: "BNB",
    feeAmount: 0.0005,
    isMaker: false,
    reference: "424242",
    confirmedBy: "GET /api/v3/order plus 1 trade record(s)",
    ...over,
  };
}

const DRY_RUN: Policy = { version: 1, mode: "dry-run" };
const LIVE: Policy = { version: 1, mode: "live" };

function saveEnv(names: string[]): () => void {
  const saved = names.map((name) => [name, process.env[name]] as const);
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function inTempLedger(body: (ledger: Ledger, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "crucible-exec-"));
  try {
    await body(new Ledger({ dir }), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run `body` with the global fetch replaced by one that throws.
 *
 * A refusal that still transmits is the failure these tests exist to catch, so
 * an attempted call is counted rather than quietly satisfied.
 */
async function withNetworkBlocked(body: () => Promise<void>): Promise<{ attempts: number }> {
  const real = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (() => {
    attempts++;
    throw new Error("A test tried to reach the network.");
  }) as unknown as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
  return { attempts };
}

// ---------------------------------------------------------------------------
// The two switches
// ---------------------------------------------------------------------------

test("assertLive refuses a dry-run policy and says which field to change", () => {
  const restore = saveEnv(["CRUCIBLE_LIVE"]);
  try {
    process.env.CRUCIBLE_LIVE = "1";
    assert.throws(() => assertLive(DRY_RUN), (err: unknown) => {
      assert.ok(err instanceof ExecutionError);
      assert.match(err.message, /Policy mode is "dry-run"/);
      assert.match(err.message, /"mode": "live"/);
      assert.match(err.message, /Nothing has been sent/);
      return true;
    });
  } finally {
    restore();
  }
});

test("assertLive refuses when the shell switch is unset and names it", () => {
  const restore = saveEnv(["CRUCIBLE_LIVE"]);
  try {
    delete process.env.CRUCIBLE_LIVE;
    assert.throws(() => assertLive(LIVE), (err: unknown) => {
      assert.ok(err instanceof ExecutionError);
      assert.match(err.message, /CRUCIBLE_LIVE is not set to 1/);
      assert.match(err.message, /Nothing has been sent/);
      return true;
    });

    // Anything other than exactly "1" is still off.
    process.env.CRUCIBLE_LIVE = "true";
    assert.throws(() => assertLive(LIVE), ExecutionError);
    process.env.CRUCIBLE_LIVE = "0";
    assert.throws(() => assertLive(LIVE), ExecutionError);
  } finally {
    restore();
  }
});

test("assertLive passes only when both switches agree", () => {
  const restore = saveEnv(["CRUCIBLE_LIVE"]);
  try {
    process.env.CRUCIBLE_LIVE = "1";
    assert.doesNotThrow(() => assertLive(LIVE));
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Plan expiry
// ---------------------------------------------------------------------------

test("a plan is executable inside its TTL", () => {
  const p = plan();

  assert.doesNotThrow(() => assertExecutable(p, p.createdAt));
  assert.doesNotThrow(() => assertExecutable(p, p.expiresAt - 1));
  // The boundary itself is still inside: the check is a strict >.
  assert.doesNotThrow(() => assertExecutable(p, p.expiresAt));
});

test("an expired plan is refused and named", () => {
  const p = plan();

  assert.throws(() => assertExecutable(p, p.expiresAt + 4000), (err: unknown) => {
    assert.ok(err instanceof RouteError);
    assert.ok(err.message.includes(`Plan ${p.id} expired`), `message lost the id: ${err.message}`);
    assert.match(err.message, /take a fresh quote/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

test("a buy filled above the mid cost money", () => {
  // 752.752 against a mid of 752 is 0.752, which is exactly 10 bps.
  const receipt = buildReceipt(plan(), snapshot(), [fill()], CREATED_AT + 1500);

  closeTo(receipt.realisedBps, 10);
  closeTo(receipt.realisedUsd, (10 / 10_000) * 752.752);
  assert.equal(receipt.planId, plan().id);
  assert.equal(receipt.fingerprint, FINGERPRINT);
  assert.equal(receipt.completedAt, CREATED_AT + 1500);
});

test("a buy filled below the mid saved money", () => {
  const receipt = buildReceipt(
    plan(),
    snapshot(),
    [fill({ filledQuoteQty: 751.248, avgPrice: 751.248 })],
    CREATED_AT + 1500,
  );

  closeTo(receipt.realisedBps, -10);
  closeTo(receipt.realisedUsd, (-10 / 10_000) * 751.248);
});

test("a sell above the mid saved money, so the sign flips", () => {
  const sell = plan({ intent: { symbol: "BNBUSDT", side: "SELL", baseQty: 1 } });
  const receipt = buildReceipt(sell, snapshot(), [fill()], CREATED_AT + 1500);

  closeTo(receipt.realisedBps, -10);
});

test("a sell below the mid cost money", () => {
  const sell = plan({ intent: { symbol: "BNBUSDT", side: "SELL", baseQty: 1 } });
  const receipt = buildReceipt(
    sell,
    snapshot(),
    [fill({ filledQuoteQty: 751.248, avgPrice: 751.248 })],
    CREATED_AT + 1500,
  );

  closeTo(receipt.realisedBps, 10);
});

test("errorBps is the realised cost minus the predicted one", () => {
  const receipt = buildReceipt(plan(), snapshot(), [fill()], CREATED_AT + 1500);

  closeTo(receipt.errorBps, 10 - 7.5);
  closeTo(receipt.errorBps, receipt.realisedBps - receipt.predicted.totalBps);
  assert.equal(receipt.predicted.totalBps, 7.5);
});

test("the saving is measured against the best route that could have been used", () => {
  const p = plan({
    alternatives: [
      onchainRoute({ unavailable: "ONCHAIN is not in your venue allowlist." }),
      onchainRoute({ totalBps: 18, totalUsd: (18 / 10_000) * MID }),
    ],
  });
  const receipt = buildReceipt(p, snapshot(), [fill()], CREATED_AT + 1500);

  // The unusable route is skipped: comparing against a route that could not have
  // filled would credit the decision with a saving it never had.
  assert.equal(receipt.alternative?.totalBps, 18);
  closeTo(receipt.savingBps, 18 - 10);
  closeTo(receipt.savingUsd, ((18 - 10) / 10_000) * 752.752);
});

test("no alternative means no saving to claim", () => {
  const receipt = buildReceipt(plan({ alternatives: [] }), snapshot(), [fill()], CREATED_AT + 1500);

  assert.equal(receipt.alternative, null);
  assert.equal(receipt.savingBps, 0);
  assert.equal(receipt.savingUsd, 0);
});

test("an order that filled nothing produces zeros rather than NaN", () => {
  const nothing = fill({
    status: "FAILED",
    filledBaseQty: 0,
    filledQuoteQty: 0,
    avgPrice: 0,
    feeAmount: 0,
  });

  for (const fills of [[], [nothing]]) {
    const receipt = buildReceipt(plan(), snapshot(), fills, CREATED_AT + 1500);

    assert.equal(receipt.realisedBps, 0);
    assert.equal(receipt.realisedUsd, 0);
    assert.equal(receipt.savingUsd, 0);
    // Still a real number: the prediction was wrong by its whole size.
    closeTo(receipt.errorBps, -7.5);
    for (const value of [receipt.realisedBps, receipt.realisedUsd, receipt.errorBps]) {
      assert.ok(Number.isFinite(value), `${value} is not a finite number`);
    }
  }
});

test("a sliced execution collapses into one quantity-weighted price", () => {
  const fills = [
    fill({ filledBaseQty: 1, filledQuoteQty: 752.752, avgPrice: 752.752, reference: "424242" }),
    fill({ filledBaseQty: 3, filledQuoteQty: 2260.512, avgPrice: 753.504, reference: "424243" }),
  ];

  const receipt = buildReceipt(plan(), snapshot(), fills, CREATED_AT + 31_500);

  // 3013.264 over 4 BNB is 753.316, which is 17.5 bps above the mid. The plain
  // average of the two prices is 753.128, or 15 bps, so this only passes if the
  // sizes are actually weighted.
  closeTo(receipt.realisedBps, 17.5);
  closeTo(receipt.realisedUsd, (17.5 / 10_000) * 3013.264);
  closeTo(receipt.errorBps, 17.5 - 7.5);
  assert.equal(receipt.fills.length, 2);
});

// ---------------------------------------------------------------------------
// Refusals reach the ledger
// ---------------------------------------------------------------------------

test("execute refuses a dry-run policy, records it, and sends nothing", async () => {
  await inTempLedger(async (ledger, dir) => {
    const p = plan();
    const restore = saveEnv(["CRUCIBLE_LIVE"]);

    const { attempts } = await withNetworkBlocked(async () => {
      process.env.CRUCIBLE_LIVE = "1";
      try {
        await assert.rejects(
          execute({
            plan: p,
            snapshot: snapshot(),
            policy: DRY_RUN,
            ledger,
            now: p.createdAt,
          }),
          (err: unknown) => {
            assert.ok(err instanceof ExecutionError);
            assert.match(err.message, /Policy mode is "dry-run"/);
            return true;
          },
        );
      } finally {
        restore();
      }
    });

    assert.equal(attempts, 0, "a dry-run refusal still tried to reach the exchange");

    const records = new Ledger({ dir }).read();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.kind, "execution.refused");
    const payload = records[0]!.payload as { planId: string; fingerprint: string; reason: string };
    assert.equal(payload.planId, p.id);
    assert.equal(payload.fingerprint, p.fingerprint);
    assert.match(payload.reason, /Policy mode is "dry-run"/);
  });
});

test("execute refuses an expired plan before it looks at the live switch", async () => {
  await inTempLedger(async (ledger, dir) => {
    const p = plan();
    const restore = saveEnv(["CRUCIBLE_LIVE"]);

    const { attempts } = await withNetworkBlocked(async () => {
      // Live is fully switched on, so the only thing left to refuse on is age.
      process.env.CRUCIBLE_LIVE = "1";
      try {
        await assert.rejects(
          execute({
            plan: p,
            snapshot: snapshot(),
            policy: LIVE,
            ledger,
            now: p.expiresAt + 90_000,
          }),
          (err: unknown) => {
            assert.ok(err instanceof RouteError);
            assert.ok(err.message.includes(`Plan ${p.id} expired`));
            return true;
          },
        );
      } finally {
        restore();
      }
    });

    assert.equal(attempts, 0, "an expired plan still tried to reach the exchange");

    const records = new Ledger({ dir }).read();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.kind, "execution.refused");
    const payload = records[0]!.payload as { reason: string };
    assert.match(payload.reason, /expired/);
  });
});

test("execute checks expiry before the policy mode", async () => {
  await inTempLedger(async (ledger) => {
    const p = plan();
    const restore = saveEnv(["CRUCIBLE_LIVE"]);
    try {
      delete process.env.CRUCIBLE_LIVE;
      // Both checks would fail. The one that runs first decides the message, and
      // a stale plan is the more useful thing to be told about.
      await assert.rejects(
        execute({
          plan: p,
          snapshot: snapshot(),
          policy: DRY_RUN,
          ledger,
          now: p.expiresAt + 1,
        }),
        (err: unknown) => {
          assert.ok(err instanceof RouteError, `expected the expiry error, got ${String(err)}`);
          return true;
        },
      );
    } finally {
      restore();
    }
  });
});
