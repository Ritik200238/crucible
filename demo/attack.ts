#!/usr/bin/env node
/**
 * Nine ways to get money out of this thing, run against the real code.
 *
 * Every defence here exists because the attack it stops used to work. None of
 * them came from reading the code and imagining what might go wrong: each one
 * came from sitting on the attacker's side and trying to get an order through
 * that should not have got through. Three of these moved real money to the
 * wrong place before they were fixed.
 *
 * This runs the actual modules — the same policy engine, the same book walker,
 * the same ledger the product uses — and reports whether each attack still
 * works. It is not a test log. If a defence regresses, this script says so and
 * exits non-zero.
 *
 *   node --experimental-strip-types demo/attack.ts
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ledger } from "../src/ledger/chain.ts";
import { verifyLedger } from "../src/ledger/verify.ts";
import { assertSpendable } from "../src/exec/execute.ts";
import { deriveState, emptyState } from "../src/risk/state.ts";
import { evaluate } from "../src/risk/engine.ts";
import { assertUsableBook, walkBook } from "../src/snapshot.ts";
import { priceAllRoutes, DEFAULT_MAX_DIVERGENCE_BPS } from "../src/cost/model.ts";
import { route } from "../src/decide/router.ts";
import { DEFAULT_POLICY } from "../src/config.ts";
import { walletServiceFee } from "../src/venues/onchain.ts";
import type {
  ConfirmedFill,
  EvaluationContext,
  OrderBook,
  Plan,
  Policy,
  ProposedOrder,
  Snapshot,
} from "../src/types.ts";

const colour = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;
const paint = (code: string, s: string) => (colour ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => paint("2", s);
const bold = (s: string) => paint("1", s);
const red = (s: string) => paint("31", s);
const green = (s: string) => paint("32", s);

const temps: string[] = [];
function tempLedger(): Ledger {
  const dir = mkdtempSync(join(tmpdir(), "crucible-attack-"));
  temps.push(dir);
  return new Ledger({ dir });
}

const fill = (over: Partial<ConfirmedFill> = {}): ConfirmedFill => ({
  venue: "BINANCE_SPOT",
  status: "FILLED",
  filledBaseQty: 33,
  filledQuoteQty: 24_000,
  avgPrice: 727.27,
  fees: [],
  totalFeeInQuote: 0,
  isMaker: false,
  reference: "1",
  confirmedBy: "attack-demo",
  ...over,
});

const order = (over: Partial<ProposedOrder> = {}): ProposedOrder => ({
  symbol: "BNBUSDT",
  side: "BUY",
  type: "MARKET",
  market: "SPOT",
  quoteOrderQty: 24_000,
  ...over,
});

const context = (policy: Policy, ledger: Ledger): EvaluationContext => ({
  policy,
  account: { equityUsd: 10_000_000, positions: [], realisedPnlTodayUsd: 0, source: "simulated" },
  state: deriveState(ledger.read(), Date.now()),
  markPrice: 727.27,
  now: new Date(),
});

const book = (over: Partial<OrderBook> = {}): OrderBook => ({
  lastUpdateId: 1,
  bids: [
    { price: 751, qty: 10 },
    { price: 750, qty: 10 },
  ],
  asks: [
    { price: 752, qty: 10 },
    { price: 753, qty: 10 },
  ],
  ...over,
});

/** A book deep enough that the exchange side prices without complaint. */
const POISON_MID = 752;
const deepBook = (): OrderBook => ({
  lastUpdateId: 1,
  bids: Array.from({ length: 20 }, (_, i) => ({ price: POISON_MID - 0.01 * (i + 1), qty: 50 })),
  asks: Array.from({ length: 20 }, (_, i) => ({ price: POISON_MID + 0.01 * (i + 1), qty: 50 })),
});

/** A snapshot whose on-chain pool quotes `poolPrice` per base unit. */
function snapshotWithPool(poolPrice: number): Snapshot {
  const amountIn = POISON_MID * 10;
  const tier = { feeTier: 100, amountOut: amountIn / poolPrice, price: 1 / poolPrice, gasEstimate: 100_000 };
  return {
    symbol: "BNBUSDT",
    takenAt: Date.now(),
    mid: POISON_MID,
    bestBid: POISON_MID - 0.01,
    bestAsk: POISON_MID + 0.01,
    spreadBps: 0.27,
    book: deepBook(),
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
    flow: {
      hitsBidPerSec: 3,
      liftsAskPerSec: 3,
      windowSec: 60,
      adverseBuyBps: 0.6,
      adverseSellBps: 0.5,
      adverseSamples: 400,
      volExchangeBps: 1.5,
      volSettlementBps: 1.8,
    },
    onchain: {
      chainId: 56,
      tokenIn: "0x",
      tokenOut: "0x",
      amountIn,
      tiers: [tier],
      best: tier,
      gasPriceWei: 50_000_000,
      gasCostUsd: 0.006,
      referencePrice: 1 / poolPrice,
      walletQuote: null,
    },
    hash: "attack-fixture",
  };
}

interface Attack {
  /** What an attacker is trying to achieve, in their words. */
  goal: string;
  /** Why it used to work. */
  why: string;
  /** Returns how the attempt was stopped, or null if it succeeded. */
  run: () => string | null;
}

const attacks: Attack[] = [
  {
    goal: "Slip $2,000,000 past a $25,000 per-order cap by sending it as 80 orders",
    why: "The cumulative rules read counters that started at zero on every call, so the eightieth slice looked exactly like the first.",
    run: () => {
      const policy: Policy = { ...DEFAULT_POLICY, maxOrderNotionalUsd: 25_000, maxDailyNotionalUsd: 100_000 };
      const ledger = tempLedger();

      // Prove the attack is real against a blind evaluator first: with no
      // memory behind it, every one of eighty slices is waved through.
      const blind: EvaluationContext = { ...context(policy, ledger), state: emptyState() };
      let blindPassed = 0;
      for (let i = 0; i < 80; i++) if (evaluate(order(), blind).verdict !== "BLOCK") blindPassed++;
      if (blindPassed !== 80) return "the blind case did not reproduce; this attack is no longer meaningful";

      // Now the same eighty against state derived from the ledger.
      let sent = 0;
      for (let i = 0; i < 80; i++) {
        const verdict = evaluate(order(), context(policy, ledger));
        if (verdict.verdict === "BLOCK") {
          return `stopped at slice ${sent + 1} of 80 by ${verdict.blockedBy.join(", ")} — $${(
            sent * 24_000
          ).toLocaleString()} through, cap $100,000`;
        }
        ledger.append("execution.completed", {
          planId: `p${i}`,
          symbol: "BNBUSDT",
          side: "BUY",
          fills: [fill({ reference: String(i) })],
        });
        sent++;
      }
      return null;
    },
  },
  {
    goal: "Execute one authorised plan twice inside its own 60-second window",
    why: "Expiry was the only check. A plan stayed valid for a minute, and nothing recorded that it had been spent.",
    run: () => {
      const ledger = tempLedger();
      const plan = {
        id: "replay000001",
        fingerprint: "deadbeefcafe0001",
        intent: { symbol: "BNBUSDT", side: "BUY", baseQty: 1 },
        snapshotHash: "s",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        chosen: {
          venue: "BINANCE_SPOT",
          style: "TAKER",
          components: [],
          totalBps: 10,
          totalUsd: 1,
          effectivePrice: 752,
          hasEstimates: false,
          notes: [],
        },
        alternatives: [],
        savingBps: 0,
        savingUsd: 0,
        baseQty: 1,
        quoteQty: 752,
        slices: [],
        rationale: "",
      } as Plan;

      assertSpendable(plan, ledger); // first use: legitimate
      ledger.append("execution.started", { planId: plan.id, fingerprint: plan.fingerprint });
      try {
        assertSpendable(plan, ledger); // second use: the attack
        return null;
      } catch (err) {
        return `refused on the second attempt — ${(err as Error).message.split(".")[0]}`;
      }
    },
  },
  {
    goal: "Get a better fill price out of a book carrying a negative quantity",
    why: "The walk subtracted each level's size from what was left. A negative size increased what remained and lowered the running average, producing a price that never existed on any venue.",
    run: () => {
      const corrupt = book({
        asks: [
          { price: 752, qty: -5 },
          { price: 753, qty: 10 },
        ],
      });
      const walk = walkBook(corrupt, "BUY", 5);
      if (walk.avgPrice < 753) return null;
      return `the poisoned level was skipped; filled at ${walk.avgPrice} off ${walk.levelsUsed} real level(s)`;
    },
  },
  {
    goal: "Trade against a crossed book, where the bid is above the ask",
    why: "A crossed book still walks and still returns a confident-looking number. Halted and glitched markets both produce one.",
    run: () => {
      try {
        assertUsableBook(book({ bids: [{ price: 760, qty: 10 }] }), "BNBUSDT");
        return null;
      } catch (err) {
        return `refused — ${(err as Error).message.split(".")[0]}`;
      }
    },
  },
  {
    goal: "Route an order into a pool quoting 99% below the exchange",
    why: "The cheapest venue won on price alone. A stale quote, a look-alike token or a manipulated pool all present as a spectacular bargain.",
    run: () => {
      // Priced through the real router, not checked against a constant. The
      // pool offers BNB at 1% of the exchange price — a 9,900 bps discount that
      // would have won on cost alone and sent the order into it.
      const poisoned = snapshotWithPool(POISON_MID * 0.01);
      const priced = priceAllRoutes({ snapshot: poisoned, side: "BUY", baseQty: 10 });
      const onchain = priced.find((r) => r.venue === "ONCHAIN")!;
      if (!onchain.unavailable) return null;

      // Refusing the venue must not refuse the trade: it still has to route.
      const plan = route({
        intent: { symbol: "BNBUSDT", side: "BUY", baseQty: 10 },
        snapshot: poisoned,
        policy: { ...DEFAULT_POLICY, maxDailyNotionalUsd: undefined },
      });
      if (plan.chosen.venue !== "BINANCE_SPOT") return null;

      return (
        `the pool was dropped past the ${DEFAULT_MAX_DIVERGENCE_BPS} bps divergence bound and the ` +
        `order still routed, to ${plan.chosen.venue} at ${plan.chosen.totalBps.toFixed(2)} bps`
      );
    },
  },
  {
    goal: "Hide a fee by charging it in an asset the comparison ignores",
    why: "The route was priced as if the wallet's service fee were zero on every pair. On assets outside the free schedule it is 0.5% — fifty basis points, larger than everything else combined.",
    run: () => {
      const free = walletServiceFee("WBNB", "USDT");
      const charged = walletServiceFee("XRP", "USDT");
      if (free.rate !== 0 || charged.rate <= 0) return null;
      return `${charged.rate * 10_000} bps charged on XRP/USDT and 0 bps on WBNB/USDT, with the unconfirmed case assumed expensive`;
    },
  },
  {
    goal: "Rewrite a past execution to free up the daily cap",
    why: "Nothing stops an operator editing their own file. What has to break is the ability to make the edit look untouched.",
    run: () => {
      const dir = mkdtempSync(join(tmpdir(), "crucible-attack-"));
      temps.push(dir);
      const ledger = new Ledger({ dir });
      ledger.append("execution.completed", {
        planId: "p",
        symbol: "BNBUSDT",
        side: "BUY",
        fills: [fill()],
      });
      ledger.append("execution.completed", {
        planId: "q",
        symbol: "BNBUSDT",
        side: "BUY",
        fills: [fill({ reference: "2" })],
      });
      const before = deriveState(ledger.read()).notionalTodayUsd;

      // Edit the first record's fill down, the way someone freeing headroom
      // would, and leave every hash exactly as it was.
      const path = join(dir, "ledger.jsonl");
      const lines = readFileSync(path, "utf8").trimEnd().split("\n");
      lines[0] = lines[0]!.replace('"filledQuoteQty":24000', '"filledQuoteQty":1');
      writeFileSync(path, lines.join("\n") + "\n");

      const after = deriveState(new Ledger({ dir }).read()).notionalTodayUsd;
      if (after >= before) return "the edit did not take, so this attack proves nothing";

      const check = verifyLedger({ dir });
      // Failing for any reason is not the claim. The claim is that it fails at
      // the record that was edited, so the break points at the tampering rather
      // than at some unrelated condition that would mask it.
      if (check.ok || check.brokenAt !== 0) return null;
      return (
        `the counter moved $${before.toLocaleString()} → $${after.toLocaleString()}, but the ledger ` +
        `no longer verifies: record ${check.brokenAt} was changed after it was written`
      );
    },
  },
  {
    goal: "Send an order, cut the read-back, then send it again under the daily cap",
    why: "A read-back that timed out was recorded as a failure, and an order that had actually reached the exchange vanished from every cap the moment the network was slow.",
    run: () => {
      const policy: Policy = { ...DEFAULT_POLICY, maxOrderNotionalUsd: 100_000, maxDailyNotionalUsd: 100_000 };
      const ledger = tempLedger();

      // The first order left for the exchange and was never read back. This is
      // the record execute() writes in that case; nothing here is invented.
      ledger.append("execution.unconfirmed", {
        planId: "cut-off",
        fingerprint: "fp-cut-off",
        symbol: "BNBUSDT",
        side: "BUY",
        mid: 727.27,
        predictedBps: 10,
        submitted: [{ venue: "BINANCE_SPOT", reference: "5100200", baseQty: 82.5, quoteQty: 60_000 }],
        confirmedFills: [],
        reason: "read-back timed out",
      });

      // Blind to in-flight orders, the second $60,000 is judged against an
      // empty day and waved through: $120,000 against a $100,000 cap.
      const blind: EvaluationContext = { ...context(policy, ledger), state: emptyState() };
      if (evaluate(order({ quoteOrderQty: 60_000 }), blind).verdict === "BLOCK") {
        return "the blind case did not reproduce; this attack is no longer meaningful";
      }

      const verdict = evaluate(order({ quoteOrderQty: 60_000 }), context(policy, ledger));
      if (verdict.verdict !== "BLOCK") return null;
      const state = deriveState(ledger.read(), Date.now());
      return (
        `the unresolved $60,000 is still held (${state.unresolved.length} order in flight), so the second ` +
        `$60,000 is refused by ${verdict.blockedBy.join(", ")} — the hold only lifts when the venue answers`
      );
    },
  },
  {
    goal: "Walk a mis-sorted book so the order prices against levels in the wrong sequence",
    why: "Out-of-order levels still walk. The result overstates or understates every cost depending on which way the sort broke.",
    run: () => {
      try {
        assertUsableBook(
          book({
            asks: [
              { price: 760, qty: 10 },
              { price: 752, qty: 10 },
            ],
          }),
          "BNBUSDT",
        );
        return null;
      } catch (err) {
        return `refused — ${(err as Error).message.split(".")[0]}`;
      }
    },
  },
];

console.log();
console.log(`  ${bold("Attacks against Crucible, run against the real modules.")}`);
console.log(`  ${dim("Each of these worked once. Three of them moved money to the wrong place.")}`);

let broken = 0;
for (const [i, attack] of attacks.entries()) {
  const outcome = attack.run();
  console.log();
  console.log(`  ${bold(`${i + 1}. ${attack.goal}`)}`);
  console.log(`     ${dim(attack.why)}`);
  if (outcome === null) {
    broken++;
    console.log(`     ${red("STILL WORKS")} — the defence has regressed.`);
  } else {
    console.log(`     ${green("STOPPED")} ${outcome}`);
  }
}

for (const dir of temps) rmSync(dir, { recursive: true, force: true });

console.log();
if (broken > 0) {
  console.log(`  ${red(`${broken} of ${attacks.length} attacks succeeded.`)}`);
  process.exit(1);
}
console.log(`  ${dim(`All ${attacks.length} attacks stopped. Each defence is pinned by a regression test.`)}`);
console.log();
