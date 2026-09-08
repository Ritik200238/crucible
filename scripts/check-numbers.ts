/**
 * Guard against documentation drift.
 *
 * The README and the evidence document both quote figures computed from
 * `data/samples.jsonl`. They are generated rather than typed, but a generated
 * block is only trustworthy while it is regenerated — an edit to the source
 * data with no regeneration leaves both documents quietly stating something the
 * data no longer says.
 *
 * This recomputes the report and checks the committed documents against it.
 * It fails the build rather than warning, because a number nobody is forced to
 * fix is a number that stays wrong.
 */

import { readFileSync, existsSync } from "node:fs";
import { isSample, readSamples } from "../src/sampler/run.ts";
import { summarise } from "../src/sampler/analyse.ts";

const problems: string[] = [];

const samples = readSamples().filter(isSample);
if (samples.length === 0) {
  console.error("No samples on disk, so there are no documented numbers to check.");
  process.exit(0);
}

const report = summarise(samples);

/** Every bucket line the generator would produce, as it would appear. */
const expectedRows = report.buckets.map(
  (b) =>
    `| ${b.symbol} | $${b.notionalUsd.toLocaleString("en-US")} | ${b.count} | ` +
    `${(b.onchainWinRate * 100).toFixed(0)}% |`,
);

for (const file of ["README.md", "docs/EXECUTION_EVIDENCE.md"]) {
  if (!existsSync(file)) {
    problems.push(`${file} is missing.`);
    continue;
  }
  const text = readFileSync(file, "utf8");
  for (const row of expectedRows) {
    if (!text.includes(row)) {
      problems.push(
        `${file} does not contain the current row "${row.trim()}". Run: npm run evidence`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error("Documented numbers have drifted from the data:\n");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.error(
  `Documented numbers match ${report.total} samples across ${report.buckets.length} buckets.`,
);
