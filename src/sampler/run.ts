/**
 * The evidence sampler.
 *
 * Every few minutes it prices the same trade on both venues and writes down
 * what each would have cost. Nothing is executed and no credential is needed —
 * these are public endpoints on both sides.
 *
 * It exists because the central claim of this product is comparative, and a
 * comparison made once is an anecdote. Which venue is cheaper moves with size,
 * with the spread, with gas, and with how far the pool has drifted from the
 * exchange. Only a run of samples across hours and sizes can say how often each
 * wins, and that takes elapsed time rather than effort — so it starts on day one
 * and the analysis is written against whatever it has collected.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { takeSnapshot } from "../snapshot.ts";
import { priceAllRoutes } from "../cost/model.ts";
import type { Side } from "../types.ts";

export const SAMPLE_PATH = "data/samples.jsonl";

/** Sizes in USD. Chosen to straddle the point where the venues converge. */
export const DEFAULT_SIZES = [100, 1_000, 10_000, 100_000];
export const DEFAULT_SYMBOLS = ["BNBUSDT", "ETHUSDT"];
export const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

/** One priced comparison at one instant. */
export interface Sample {
  at: string;
  symbol: string;
  side: Side;
  notionalUsd: number;
  baseQty: number;
  mid: number;
  spreadBps: number;
  snapshotHash: string;
  /** Keyed by `${venue}/${style}`. Absent when that route could not be priced. */
  routes: Record<string, number>;
  /** Named breakdown of the on-chain cost, so the analysis can attribute it. */
  onchainParts?: Record<string, number>;
  cheapest: string | null;
  /** Cheapest against the best rejected route. */
  edgeBps: number | null;
}

export interface SampleFailure {
  at: string;
  symbol: string;
  notionalUsd: number;
  error: string;
}

function append(path: string, row: unknown): void {
  const full = resolve(process.cwd(), path);
  mkdirSync(dirname(full), { recursive: true });
  appendFileSync(full, JSON.stringify(row) + "\n", "utf8");
}

/**
 * Price one (symbol, size) pair on every route.
 *
 * A failure is written down rather than swallowed. A day where the pool was
 * unreachable is a real fact about the comparison, and dropping those rows would
 * quietly bias the result toward whichever venue happened to be answering.
 */
export async function sampleOnce(
  symbol: string,
  notionalUsd: number,
  side: Side = "BUY",
  path = SAMPLE_PATH,
): Promise<Sample | SampleFailure> {
  const at = new Date().toISOString();
  try {
    // A cheap Binance-only snapshot first, purely to turn dollars into a base
    // quantity. The real snapshot then prices both venues at that exact size.
    const probe = await takeSnapshot({ symbol, side, baseQty: 1, skipOnchain: true });
    const baseQty = notionalUsd / probe.mid;

    const snapshot = await takeSnapshot({ symbol, side, baseQty });
    const routes = priceAllRoutes({ snapshot, side, baseQty });

    const priced: Record<string, number> = {};
    for (const r of routes) {
      if (!r.unavailable) priced[`${r.venue}/${r.style}`] = Number(r.totalBps.toFixed(4));
    }

    const usable = routes.filter((r) => !r.unavailable).sort((a, b) => a.totalBps - b.totalBps);
    const best = usable[0];
    const runnerUp = usable[1];
    const onchain = routes.find((r) => r.venue === "ONCHAIN" && !r.unavailable);

    const row: Sample = {
      at,
      symbol,
      side,
      notionalUsd,
      baseQty: Number(baseQty.toFixed(8)),
      mid: snapshot.mid,
      spreadBps: Number(snapshot.spreadBps.toFixed(4)),
      snapshotHash: snapshot.hash,
      routes: priced,
      ...(onchain
        ? {
            onchainParts: Object.fromEntries(
              onchain.components.map((c) => [c.name, Number(c.bps.toFixed(4))]),
            ),
          }
        : {}),
      cheapest: best ? `${best.venue}/${best.style}` : null,
      edgeBps: best && runnerUp ? Number((runnerUp.totalBps - best.totalBps).toFixed(4)) : null,
    };

    append(path, row);
    return row;
  } catch (err) {
    const row: SampleFailure = { at, symbol, notionalUsd, error: (err as Error).message };
    append(path, row);
    return row;
  }
}

/** One full pass over every symbol and size. Sequential, to stay inside rate limits. */
export async function sampleSweep(
  symbols = DEFAULT_SYMBOLS,
  sizes = DEFAULT_SIZES,
  path = SAMPLE_PATH,
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  for (const symbol of symbols) {
    for (const size of sizes) {
      const row = await sampleOnce(symbol, size, "BUY", path);
      if ("error" in row) failed++;
      else ok++;
      // Spacing keeps the sweep well under Binance's per-minute weight budget
      // and gives the RPC pool room; the sampler runs for days, so it has no
      // reason to hurry.
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return { ok, failed };
}

export function readSamples(path = SAMPLE_PATH): (Sample | SampleFailure)[] {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) return [];
  return readFileSync(full, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Sample | SampleFailure];
      } catch {
        return [];
      }
    });
}

export const isSample = (r: Sample | SampleFailure): r is Sample => !("error" in r);

/** Run forever, one sweep per interval. Started as a background process. */
export async function runForever(intervalMs = DEFAULT_INTERVAL_MS): Promise<never> {
  for (;;) {
    const started = Date.now();
    const { ok, failed } = await sampleSweep();
    // stderr, so redirecting stdout to a file leaves a clean log either way.
    console.error(
      `[sampler] ${new Date().toISOString()} swept ${ok + failed} rows (${failed} failed) in ${Date.now() - started}ms`,
    );
    const elapsed = Date.now() - started;
    await new Promise((r) => setTimeout(r, Math.max(1000, intervalMs - elapsed)));
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!)) {
  const interval = Number(process.env.SAMPLER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  console.error(`[sampler] starting, sweeping every ${Math.round(interval / 1000)}s`);
  await runForever(interval);
}
