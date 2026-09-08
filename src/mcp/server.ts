#!/usr/bin/env node
/**
 * Crucible MCP server.
 *
 * The surface an AI agent talks to. It exposes the same calls the CLI makes,
 * against the same code, so anything demonstrated in a terminal is what an
 * agent actually gets.
 *
 * The tool split is deliberate. `quote` prices without deciding, `route`
 * decides and produces a fingerprinted plan, and `execute` takes only a plan id
 * — never an order. An agent therefore cannot ask this server to trade
 * something the risk engine has not already seen and priced, and cannot alter
 * the order between the decision and the fill. Any change to the intent
 * produces a different plan, which has to clear the gates again.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { takeSnapshot } from "../snapshot.ts";
import { priceAllRoutes } from "../cost/model.ts";
import { measuredImpactBps, route, RouteError } from "../decide/router.ts";
import { evaluate } from "../risk/engine.ts";
import { ALL_RULES } from "../risk/rules.ts";
import { ConfigError, isLiveEnabled, loadPolicy } from "../config.ts";
import { Ledger } from "../ledger/chain.ts";
import { deriveState, emptyState } from "../risk/state.ts";
import { verifyLedger } from "../ledger/verify.ts";
import { calibration } from "../exec/calibration.ts";
import { isSample, readSamples } from "../sampler/run.ts";
import { summarise } from "../sampler/analyse.ts";
import { credentialsFromEnv, DEMO, MAINNET, type Credentials } from "../exec/binance-rest.ts";
import { execute, ExecutionError, reconcile } from "../exec/execute.ts";
import { walletStatus, walletVersion } from "../exec/wallet.ts";
import { BinanceError, fetchMid } from "../venues/binance.ts";
import { OnchainError } from "../venues/onchain.ts";
import { SnapshotError } from "../snapshot.ts";
import type { Plan, RollingState, Side, Snapshot } from "../types.ts";

const CONFIG_PATH = process.env.CRUCIBLE_CONFIG;

/**
 * Plans awaiting execution, held only in memory.
 *
 * Deliberately not persisted. A plan is a claim about the market at one
 * instant; one that survived a restart would be a stale decision wearing a
 * fresh id. They expire on their own, and this map is swept so a long-running
 * server does not accumulate them.
 */
const plans = new Map<string, { plan: Plan; snapshot: Snapshot }>();

function rememberPlan(plan: Plan, snapshot: Snapshot): void {
  for (const [id, held] of plans) {
    if (Date.now() > held.plan.expiresAt + 60_000) plans.delete(id);
  }
  plans.set(plan.id, { plan, snapshot });
}

const server = new McpServer(
  { name: "crucible", version: "0.1.0" },
  {
    instructions:
      "Crucible routes a trade to whichever venue fills it cheapest — Binance spot or on-chain — " +
      "and proves the result. Always call `route` before trading, and pass the plan id it returns " +
      "to `execute`. Never describe a trade as done on the strength of `execute` alone: report the " +
      "confirmed fill it returns, including its reference. If `route` reports a BLOCK, that is " +
      "final: do not retry, do not split the order to get under a cap, and do not route it through " +
      "another tool. Tell the user which rule stopped it.",
  },
);

/**
 * The cumulative counters, rebuilt from the ledger.
 *
 * Reading them fresh on every call is what makes the daily and hourly rules
 * mean anything. A missing or unreadable ledger yields empty counters, which is
 * the conservative direction: every cap then applies in full rather than
 * reading as already spent.
 */
function rollingState(): RollingState {
  try {
    return deriveState(new Ledger().read());
  } catch {
    return emptyState();
  }
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (s: string) => ({ ...text(s), isError: true as const });

function describeError(err: unknown): string {
  if (
    err instanceof RouteError ||
    err instanceof ConfigError ||
    err instanceof SnapshotError ||
    err instanceof BinanceError ||
    err instanceof OnchainError ||
    err instanceof ExecutionError
  ) {
    return `${err.name}: ${err.message}`;
  }
  return `Unexpected error: ${(err as Error).message}`;
}

const bps = (n: number) => `${n.toFixed(2)} bps`;
const usd = (n: number) => `$${n.toFixed(2)}`;
const venueName = (v: string) => (v === "ONCHAIN" ? "on-chain" : "Binance spot");

const sizeShape = {
  symbol: z.string().describe("Trading pair, e.g. BNBUSDT. Must be quoted in a USD-pegged asset."),
  side: z.enum(["BUY", "SELL"]).default("BUY"),
  usd: z.number().positive().optional().describe("Size in the quote asset. Give this or baseQty."),
  baseQty: z.number().positive().optional().describe("Size in the base asset."),
};

/** Turn a requested size into a snapshot priced at exactly that size. */
async function snapshotFor(args: {
  symbol: string;
  side: Side;
  usd?: number;
  baseQty?: number;
}): Promise<{ snapshot: Snapshot; baseQty: number }> {
  if ((args.usd === undefined) === (args.baseQty === undefined)) {
    throw new RouteError("Give exactly one of usd or baseQty.");
  }
  let baseQty = args.baseQty!;
  if (args.usd !== undefined) baseQty = args.usd / (await fetchMid(args.symbol));
  const snapshot = await takeSnapshot({
    symbol: args.symbol,
    side: args.side,
    baseQty,
    includeWalletQuote: true,
  });
  return { snapshot, baseQty };
}

server.registerTool(
  "quote",
  {
    title: "Price an order on every venue",
    description:
      "Price the same order on Binance spot (taker and maker) and on-chain, at one instant, with " +
      "every cost broken out in basis points. Makes no decision and sends nothing. Use it to show " +
      "a user what a trade would cost before committing to one.",
    inputSchema: sizeShape,
  },
  async (args) => {
    try {
      const a = args as unknown as { symbol: string; side: Side; usd?: number; baseQty?: number };
      const { snapshot, baseQty } = await snapshotFor(a);
      const routes = priceAllRoutes({ snapshot, side: a.side, baseQty });
      const usable = routes.filter((r) => !r.unavailable).sort((x, y) => x.totalBps - y.totalBps);

      const lines = [
        `${a.side} ${baseQty.toFixed(6)} ${snapshot.filters.baseAsset} (${usd(baseQty * snapshot.mid)}) on ${snapshot.symbol}`,
        `mid ${snapshot.mid} · spread ${bps(snapshot.spreadBps)} · snapshot ${snapshot.hash}`,
        "",
      ];
      for (const r of routes) {
        if (r.unavailable) {
          lines.push(`${venueName(r.venue)} ${r.style.toLowerCase()}: unavailable — ${r.unavailable}`);
          continue;
        }
        lines.push(
          `${venueName(r.venue)} ${r.style.toLowerCase()}: ${bps(r.totalBps)} (${usd(r.totalUsd)})${r.hasEstimates ? " [contains modelled components]" : ""}`,
        );
        for (const comp of r.components) {
          lines.push(`    ${comp.name}: ${comp.bps.toFixed(3)} bps — ${comp.detail}`);
        }
        for (const note of r.notes) lines.push(`    note: ${note}`);
      }
      if (usable.length > 1) {
        lines.push(
          "",
          `Cheapest: ${venueName(usable[0]!.venue)} by ${bps(usable[1]!.totalBps - usable[0]!.totalBps)}.`,
        );
      }
      if (snapshot.commission.source !== "account") {
        lines.push("Fees are the public VIP 0 schedule, not read from an account.");
      }
      return text(lines.join("\n"));
    } catch (err) {
      return fail(describeError(err));
    }
  },
);

server.registerTool(
  "route",
  {
    title: "Choose a venue and gate the order",
    description:
      "Price every venue, choose the cheapest, and run the order through the risk engine. Returns " +
      "a plan id, a fingerprint, and the verdict. The plan expires in 60 seconds and can only be " +
      "executed once. Call this before any trade; pass the plan id to `execute`.",
    inputSchema: { ...sizeShape, equityUsd: z.number().positive().optional() },
  },
  async (args) => {
    try {
      const a = args as unknown as {
        symbol: string;
        side: Side;
        usd?: number;
        baseQty?: number;
        equityUsd?: number;
      };
      const { policy } = loadPolicy(CONFIG_PATH);
      const { snapshot, baseQty } = await snapshotFor(a);

      const plan = route({
        intent: { symbol: a.symbol.toUpperCase(), side: a.side, baseQty },
        snapshot,
        policy,
      });

      const decision = evaluate(
        {
          symbol: snapshot.symbol,
          side: a.side,
          type: "MARKET",
          market: "SPOT",
          quantity: plan.baseQty,
          venue: plan.chosen.venue,
        },
        {
          policy,
          account: {
            equityUsd: a.equityUsd ?? 100_000,
            positions: [],
            realisedPnlTodayUsd: 0,
            source: "simulated",
          },
          state: rollingState(),
          markPrice: snapshot.mid,
          now: new Date(),
          snapshot,
          impactBps: measuredImpactBps(snapshot, a.side, plan.baseQty),
        },
      );

      if (decision.verdict !== "BLOCK") rememberPlan(plan, snapshot);

      const lines = [
        `VERDICT: ${decision.verdict}`,
        `plan ${plan.id} · fingerprint ${plan.fingerprint} · expires in 60s`,
        `${venueName(plan.chosen.venue)} ${plan.chosen.style.toLowerCase()} at ${bps(plan.chosen.totalBps)}`,
        plan.rationale,
        "",
        ...plan.alternatives
          .filter((r) => !r.unavailable)
          .map((r) => `  rejected: ${venueName(r.venue)} ${r.style.toLowerCase()} at ${bps(r.totalBps)}`),
        "",
        ...decision.results.map(
          (r) =>
            `${r.verdict === "BLOCK" ? "[BLOCK]" : r.verdict === "CONFIRM" ? "[CONFIRM]" : "[ok]"} ${r.rule}: ${r.message}`,
        ),
        "",
      ];

      if (decision.verdict === "BLOCK") {
        lines.push(
          `Refused by: ${decision.blockedBy.join(", ")}. Nothing was sent and no plan was stored.`,
          "Do not retry this order, do not split it to get under a cap, and do not route it elsewhere.",
          "Tell the user which rule stopped it and why.",
        );
      } else if (decision.verdict === "CONFIRM") {
        lines.push(
          `Needs human approval: ${decision.confirmRequiredBy.join(", ")}.`,
          `Ask the user explicitly, then call execute with planId "${plan.id}".`,
        );
      } else {
        lines.push(
          plan.savingBps > 0.01
            ? `Saves ${bps(plan.savingBps)} (${usd(plan.savingUsd)}) against the next best route.`
            : "The routes are close; the measured one was taken.",
          isLiveEnabled(policy)
            ? `Cleared. Call execute with planId "${plan.id}".`
            : `Cleared by policy, but execution is not enabled, so nothing can be transmitted.`,
        );
      }
      return text(lines.join("\n"));
    } catch (err) {
      return fail(describeError(err));
    }
  },
);

server.registerTool(
  "execute",
  {
    title: "Execute a routed plan",
    description:
      "Execute a plan produced by `route`, by id. Takes no order details — the plan is the " +
      "authorisation, and it cannot be edited between the decision and the fill. Confirms the fill " +
      "by reading it back from the venue and returns a receipt comparing predicted to realised cost. " +
      "Report the confirmed fill and its reference; never describe a trade as done without them.",
    inputSchema: {
      planId: z.string().describe("The plan id returned by route."),
    },
  },
  async ({ planId }) => {
    try {
      const held = plans.get(planId);
      if (!held) {
        return fail(
          `No plan called "${planId}" is held. Plans live for 60 seconds and only one execution is ` +
            `possible per plan. Call route again for a fresh quote.`,
        );
      }
      const { policy } = loadPolicy(CONFIG_PATH);

      const baseUrl = process.env.CRUCIBLE_BINANCE_BASE ?? DEMO;
      const binance = (() => {
        try {
          return { baseUrl, credentials: credentialsFromEnv() };
        } catch {
          return undefined;
        }
      })();

      const receipt = await execute({
        plan: held.plan,
        snapshot: held.snapshot,
        policy,
        binance,
        ledger: new Ledger(),
      });

      // Single use: consumed whether or not it filled, so a failed attempt
      // cannot be silently retried against stale market state.
      plans.delete(planId);

      const lines = [
        `RECEIPT ${receipt.planId} · fingerprint ${receipt.fingerprint}`,
        receipt.realisedBps === null
          ? `predicted ${bps(receipt.predicted.totalBps)} · realised unavailable — ${receipt.errorUnavailable}`
          : `predicted ${bps(receipt.predicted.totalBps)} · realised ${bps(receipt.realisedBps)} ` +
            `(price ${bps(receipt.realisedGrossBps)} + commission ${bps(receipt.realisedFeeBps ?? 0)}) ` +
            `· error ${bps(receipt.errorBps ?? 0)}`,
        receipt.alternative && receipt.savingUsd !== null
          ? `the other venue would have cost ${bps(receipt.alternative.totalBps)}, so this saved ${usd(receipt.savingUsd)}`
          : receipt.alternative
            ? `the other venue would have cost ${bps(receipt.alternative.totalBps)}, but the saving cannot be stated without a complete realised cost`
            : "no alternative venue was available to compare against",
        "",
        ...receipt.fills.map(
          (f) =>
            `${f.status} on ${venueName(f.venue)}: ${f.filledBaseQty} base for ${f.filledQuoteQty} quote ` +
            `at ${f.avgPrice}, fees ${f.fees.length === 0 ? "none" : f.fees.map((c) => `${c.amount} ${c.asset}`).join(" + ")}` +
            `${f.totalFeeInQuote === null ? " (not all priceable in the quote asset)" : ""}` +
            `${f.isMaker === null ? "" : f.isMaker ? ", maker" : ", taker"} ` +
            `— reference ${f.reference}, confirmed by ${f.confirmedBy}`,
        ),
      ];
      if (baseUrl !== MAINNET) {
        lines.push("", `This ran against ${baseUrl}, not the live exchange.`);
      }
      return text(lines.join("\n"));
    } catch (err) {
      return fail(describeError(err));
    }
  },
);

server.registerTool(
  "policy",
  {
    title: "Show the active risk policy",
    description:
      "List the rules currently in force and whether execution is enabled. Use it to explain to a " +
      "user what is protecting them, or why an order was refused.",
    inputSchema: {},
  },
  async () => {
    try {
      const { policy, source } = loadPolicy(CONFIG_PATH);
      const active = ALL_RULES.filter((r) => r.isConfigured(policy));
      return text(
        [
          `mode: ${policy.mode}${isLiveEnabled(policy) ? " (execution enabled)" : " (nothing can be transmitted)"}`,
          `source: ${source}`,
          "",
          `${active.length} of ${ALL_RULES.length} rules active:`,
          ...active.map((r) => `  ${r.name}: ${r.purpose}`),
          "",
          "Limits:",
          ...Object.entries(policy)
            .filter(([k]) => k !== "version" && k !== "mode")
            .map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`),
          "",
          "This policy is read from a file the operator controls. You cannot change it. If a limit " +
            "needs raising, tell the user to edit that file themselves.",
        ].join("\n"),
      );
    } catch (err) {
      return fail(describeError(err));
    }
  },
);

server.registerTool(
  "evidence",
  {
    title: "What the venue comparison actually shows",
    description:
      "Summarise the sampled cost comparison collected so far: how often each venue was cheaper, " +
      "by how much, broken down by symbol and order size. Every figure is computed from recorded " +
      "samples, not asserted.",
    inputSchema: {},
  },
  async () => {
    const samples = readSamples().filter(isSample);
    if (samples.length === 0) {
      return text("No samples recorded yet. The sampler needs to run before there is anything to report.");
    }
    const r = summarise(samples);
    return text(
      [
        `${r.total} samples over ${r.spanHours.toFixed(1)} hours (${r.from} to ${r.to}).`,
        `On-chain was cheaper in ${(r.onchainWinRate * 100).toFixed(1)}% of them, median edge ${bps(r.medianEdgeBps)}.`,
        "",
        ...r.buckets.map(
          (b) =>
            `${b.symbol} at ${usd(b.notionalUsd)}: on-chain won ${(b.onchainWinRate * 100).toFixed(0)}% ` +
            `(n=${b.count}), median edge ${bps(b.medianEdgeBps)}, on-chain ${bps(b.medianOnchainBps)} vs Binance ${bps(b.medianBinanceBps)}`,
        ),
        "",
        r.crossoverNote,
      ].join("\n"),
    );
  },
);

server.registerTool(
  "verify_ledger",
  {
    title: "Verify the decision ledger",
    description:
      "Recompute the hash chain over every recorded decision and check the signature. Reports the " +
      "exact record where the chain breaks, if it does.",
    inputSchema: {},
  },
  async () => {
    const r = verifyLedger();
    return text(
      r.ok
        ? `Ledger intact: ${r.records} records, chain verified, signature ${r.signatureValid ? "valid" : "not checked"}.`
        : `Ledger FAILED verification at record ${r.brokenAt}: ${r.reason}`,
    );
  },
);

server.registerTool(
  "reconcile",
  {
    title: "Resolve an order whose outcome was lost",
    description:
      "When execute reports that an order was sent but its outcome could not be established, call " +
      "this with the plan id. It asks the venue again and records the answer: filled, partly filled, " +
      "or never filled. Until then the order's notional is held against the caps. Never retry an " +
      "unconfirmed order without reconciling it first — the original may have filled.",
    inputSchema: {
      planId: z.string().describe("The plan id named in the unconfirmed error."),
    },
  },
  async (args) => {
    const { planId } = args as { planId: string };
    let binance: { baseUrl: string; credentials: Credentials } | undefined;
    try {
      binance = { baseUrl: process.env.CRUCIBLE_BINANCE_BASE ?? DEMO, credentials: credentialsFromEnv() };
    } catch {
      binance = undefined;
    }
    try {
      const r = await reconcile({ planId, ledger: new Ledger(), ...(binance ? { binance } : {}) });
      const lines = [`Plan ${r.planId}: ${r.outcome.replace("_", " ")}.`];
      for (const f of r.fills) {
        lines.push(
          `  ${f.venue} ${f.status} ${f.filledBaseQty.toFixed(6)} @ ${f.avgPrice.toFixed(4)} ref ${f.reference}`,
        );
      }
      if (r.realisedBps !== null) {
        lines.push(
          `  realised ${r.realisedBps.toFixed(2)} bps` +
            (r.errorBps !== null
              ? `, ${r.errorBps >= 0 ? "+" : ""}${r.errorBps.toFixed(2)} bps against the prediction`
              : ""),
        );
      }
      if (r.outcome === "still_unresolved") {
        lines.push(`  Still open at the venue: ${r.stillOpen.join(", ")}. The hold stays. Ask again shortly.`);
      } else {
        lines.push("  The hold against the caps is released.");
      }
      return text(lines.join("\n"));
    } catch (err) {
      return fail(describeError(err));
    }
  },
);

server.registerTool(
  "calibration",
  {
    title: "How well the cost model has predicted real fills",
    description:
      "Compare what was predicted against what every executed order actually cost. Use it before " +
      "presenting a cost estimate as reliable: with no executions the model has never been graded, " +
      "and you should say so rather than implying the estimate is proven.",
    inputSchema: {},
  },
  async () => {
    let report;
    try {
      report = calibration(new Ledger().read());
    } catch {
      report = calibration([]);
    }
    if (report.samples === 0) return text(report.verdict);
    return text(
      [
        `${report.samples} executions graded${report.incomparable > 0 ? `, ${report.incomparable} not comparable` : ""}.`,
        `mean error ${bps(report.meanErrorBps ?? 0)} (positive means it cost more than predicted)`,
        `median ${bps(report.medianErrorBps ?? 0)} · typical miss ${bps(report.meanAbsErrorBps ?? 0)} · worst ${bps(report.worstErrorBps ?? 0)}`,
        "",
        ...report.byVenue.map((v) => `  ${v.venue}: ${v.samples} runs, mean ${bps(v.meanErrorBps)}`),
        "",
        report.verdict,
      ].join("\n"),
    );
  },
);

server.registerTool(
  "status",
  {
    title: "Whether each venue can actually be reached",
    description:
      "Report which execution paths are live: exchange credentials, wallet session, and whether " +
      "the policy allows transmitting anything. Use it before promising a user a trade can happen.",
    inputSchema: {},
  },
  async () => {
    const { policy } = loadPolicy(CONFIG_PATH);
    const lines: string[] = [];

    const baseUrl = process.env.CRUCIBLE_BINANCE_BASE ?? DEMO;
    try {
      credentialsFromEnv();
      lines.push(`Binance: credentials present, pointing at ${baseUrl}${baseUrl === MAINNET ? " (LIVE EXCHANGE)" : ""}.`);
    } catch {
      lines.push("Binance: no credentials set, so the exchange leg cannot execute. Quoting still works.");
    }

    const version = await walletVersion();
    if (!version) {
      lines.push("Wallet: CLI not installed, so the on-chain leg cannot execute. Quoting still works.");
    } else {
      try {
        const s = await walletStatus();
        lines.push(
          s.connected
            ? `Wallet: CLI ${version}, session connected.`
            : `Wallet: CLI ${version}, no session. Sign in with baw auth signin before trading on-chain.`,
        );
      } catch (err) {
        lines.push(`Wallet: CLI ${version}, status unavailable — ${(err as Error).message}`);
      }
    }

    lines.push(
      isLiveEnabled(policy)
        ? "Execution: ENABLED. Orders will be transmitted."
        : `Execution: disabled (mode "${policy.mode}", CRUCIBLE_LIVE ${process.env.CRUCIBLE_LIVE === "1" ? "set" : "unset"}). Nothing will be transmitted.`,
    );
    return text(lines.join("\n"));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr only: stdout carries the protocol and must hold nothing else.
console.error("crucible mcp server ready");
