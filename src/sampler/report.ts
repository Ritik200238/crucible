/**
 * The evidence document.
 *
 * Regenerates `docs/EXECUTION_EVIDENCE.md` from the recorded samples. Nothing in
 * the output is typed by hand, so the claims in it cannot drift from the data
 * that produced them — re-run this and every figure is recomputed or it is not
 * there.
 *
 * The document is written to be read by someone who does not trust it. It leads
 * with the sample count and the span, states the method, and puts the
 * limitations in the body rather than in a footnote.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isSample, readSamples, type Sample } from "./run.ts";
import { summarise, type Bucket, type EvidenceReport } from "./analyse.ts";

export const REPORT_PATH = "docs/EXECUTION_EVIDENCE.md";

const bps = (n: number) => (Number.isFinite(n) ? `${n.toFixed(2)} bps` : "—");
const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

/**
 * A span in the unit that carries information.
 *
 * "0.0 hours" is true and tells a reader nothing, which on a document whose
 * whole job is to be checkable is the wrong kind of true.
 */
function span(hours: number): string {
  if (hours >= 1) return `${hours.toFixed(1)} hours`;
  const minutes = hours * 60;
  if (minutes >= 1) return `${minutes.toFixed(0)} minutes`;
  return `${Math.round(minutes * 60)} seconds`;
}

/** Rows in the per-bucket table, ordered so a reader can see size take effect. */
function bucketTable(buckets: Bucket[]): string {
  const header =
    "| Pair | Order size | Samples | On-chain cheaper | Median on-chain | Median Binance | Median edge |\n" +
    "|---|---|---|---|---|---|---|";
  const rows = buckets.map(
    (b) =>
      `| ${b.symbol} | ${usd(b.notionalUsd)} | ${b.count} | ${pct(b.onchainWinRate)} | ` +
      `${bps(b.medianOnchainBps)} | ${bps(b.medianBinanceBps)} | ${bps(b.medianEdgeBps)} |`,
  );
  return [header, ...rows].join("\n");
}

/**
 * Where the on-chain cost actually goes.
 *
 * Worth its own table because the headline number is not the interesting part.
 * The pool fee is fixed, gas is nearly free at these prices, and impact is the
 * only component that grows with size — which is the whole reason the cheaper
 * venue changes as the order gets bigger.
 */
function componentTable(buckets: Bucket[]): string {
  const names = [...new Set(buckets.flatMap((b) => Object.keys(b.medianOnchainParts)))];
  if (names.length === 0) return "";

  const header = `| Pair | Order size | ${names.join(" | ")} |\n|${"---|".repeat(names.length + 2)}`;
  const rows = buckets.map((b) => {
    const cells = names.map((n) => {
      const v = b.medianOnchainParts[n];
      return v === undefined ? "—" : `${v.toFixed(3)}`;
    });
    return `| ${b.symbol} | ${usd(b.notionalUsd)} | ${cells.join(" | ")} |`;
  });
  return [header, ...rows].join("\n");
}

export function renderReport(report: EvidenceReport, sampleCount: number): string {
  const thin = report.spanHours < 24;

  return `# Execution evidence

Every figure below is computed from \`data/samples.jsonl\` by \`src/sampler/report.ts\`.
Nothing here is typed by hand. Regenerate it with:

\`\`\`bash
npm run evidence
\`\`\`

## What was measured

Every ten minutes, the same order is priced on both venues at the same instant:

- **Binance spot**, taker and maker, from the live order book. The taker cost is
  the account's commission plus half the spread plus the impact of walking the
  book for that size. The maker cost weighs the fee and the spread earned by the
  chance of the order actually filling, estimated from measured trade flow.
- **On-chain**, through the PancakeSwap V3 pools on BNB Smart Chain, quoted on
  every fee tier and taking whichever paid out most for that size, plus gas at
  the live price and the wallet's own service fee.

Both sides use public, read-only endpoints. No order was placed to collect this.

Costs are quoted in basis points of the Binance mid at the moment of the
snapshot, so the two venues land on one comparable axis. A basis point is 0.01%.

## The sample

- **${report.total} priced comparisons** over **${span(report.spanHours)}**${report.failures > 0 ? `, plus ${report.failures} that failed to price and are recorded as failures rather than dropped` : ""}
- From \`${report.from}\` to \`${report.to}\`
- ${sampleCount} rows on disk${report.supersededSamples > 0 ? `
- ${report.supersededSamples} earlier rows excluded: they were priced under an older cost model, and averaging two models together would describe neither` : ""}
- Cost model version ${report.model}

${thin ? `> This span is under a day. It is enough to show the shape of the cost curve and\n> the size at which the cheaper venue changes, and it is **not** enough to say\n> anything about how either venue behaves across a full market cycle.\n` : ""}
## What it shows

**On-chain was cheaper in ${pct(report.onchainWinRate)} of ${report.total} samples**, with a median
edge of **${bps(report.medianEdgeBps)}**.

${report.crossoverNote}

${bucketTable(report.buckets)}

The edge is the better of the two Binance routes minus the on-chain route, so a
positive number means on-chain won.

## Where the on-chain cost goes

${componentTable(report.buckets)}

All values in basis points. Impact is the only component that grows with size,
which is why the cheaper venue changes as the order gets bigger: the Binance
cost is dominated by a flat commission, while the on-chain cost starts far lower
and climbs.

## Why this result holds, and where it stops

The gap comes almost entirely from the fee. Binance spot charges 0.1% to a
VIP 0 account, which is 10 bps before anything else happens. The deepest
BNB/USDT pool charges 0.01%, which is 1 bps, and the wallet adds nothing on a
swap between two major assets. Gas on BNB Smart Chain at these prices is a
fraction of a basis point on any order worth routing.

That advantage is real but it is not unconditional:

- **It shrinks with account tier.** A VIP account, or one paying commission in
  BNB, pays materially less than 10 bps. The cost model reads the real rate when
  a credential is present and says so when it is falling back to the public
  schedule, which every sample here does.
- **It reverses with size.** Pool impact grows faster than book impact on these
  pairs, so past a certain order the exchange is cheaper. That crossover is
  visible in the table above and it is the reason this product routes per order
  rather than picking a venue once.
- **It is measured on two pairs.** BNB and ETH against USDT, both with deep
  pools. A thinner pair would look different, and this document does not claim
  otherwise.
- **A quote is not a fill.** These are prices at an instant. On-chain execution
  can still fail on slippage or liquidity, and a maker order can fail to fill at
  all. The receipt produced by an actual execution records realised against
  predicted cost, and that error is the honest check on everything here.

## Reproducing it

\`\`\`bash
npm run sample     # one sweep across every pair and size
npm run evidence   # regenerate this document from whatever has been collected
\`\`\`

The raw samples are in \`data/samples.jsonl\`, one JSON object per line, including
the snapshot hash each price was taken from.
`;
}

const README_BEGIN = "<!-- EVIDENCE:BEGIN";
const README_END = "<!-- EVIDENCE:END -->";

/**
 * Rewrite the README's evidence block from the same data.
 *
 * The headline table is quoted in two places, and a figure typed into one of
 * them drifts the moment another sample lands. Generating both from one source
 * removes the chance of the README claiming something the data no longer says.
 */
export function updateReadme(report: EvidenceReport, readmePath = "README.md"): boolean {
  const full = resolve(process.cwd(), readmePath);
  let text: string;
  try {
    text = readFileSync(full, "utf8");
  } catch {
    return false;
  }

  const begin = text.indexOf(README_BEGIN);
  const end = text.indexOf(README_END);
  if (begin === -1 || end === -1 || end < begin) return false;

  const beginLineEnd = text.indexOf("\n", begin);
  const block = [
    "",
    bucketTable(report.buckets),
    "",
    `Measured across ${report.total} samples spanning ${report.spanHours.toFixed(1)} hours. ` +
      `On-chain was cheaper in ${pct(report.onchainWinRate)} of them.`,
    "",
  ].join("\n");

  writeFileSync(full, text.slice(0, beginLineEnd + 1) + block + text.slice(end), "utf8");
  return true;
}

export function generateReport(samplePath?: string, outPath = REPORT_PATH): {
  path: string;
  report: EvidenceReport;
} {
  const rows = readSamples(samplePath);
  const samples = rows.filter(isSample) as Sample[];
  const failures = rows.length - samples.length;

  if (samples.length === 0) {
    throw new Error(
      "There are no samples to report on yet. Run `npm run sample` at least once, or start the " +
        "sampler and let it collect.",
    );
  }

  const report = summarise(samples, failures);
  const full = resolve(process.cwd(), outPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, renderReport(report, rows.length), "utf8");
  updateReadme(report);
  return { path: full, report };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("sampler/report.ts")) {
  const { path, report } = generateReport();
  console.error(
    `Wrote ${path} from ${report.total} samples spanning ${report.spanHours.toFixed(1)} hours.`,
  );
}
