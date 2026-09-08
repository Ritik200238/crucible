/**
 * What an agent may say it did.
 *
 * Every gate in this product governs what reaches a venue. None of them govern
 * what reaches the person — and that is the half they experience. An agent
 * whose order was refused can still write "Bought $500 of BNB, saved 8 bps."
 * No order, no fill, no record; the money was safe and the person was misled
 * anyway.
 *
 * So a summary is checked against the signed ledger the way an order is
 * checked against the policy. Five things are refused:
 *
 *   1. A figure no record carries.
 *   2. A claim of execution when nothing reached a confirmed fill.
 *   3. A summary that describes an unresolved order as done.
 *   4. A summary that quietly omits a refusal or an unresolved order that
 *      really happened — true in every word, false as an account.
 *   5. A forecast or a recommendation, which no record can ever support.
 *
 * A figure is vouched for at the precision the author chose: a record value of
 * 8.7284 grounds "8.73 bps" and "8.7 bps", and grounds "9 bps" only if it
 * rounds there. A tolerance band would grant the most licence exactly where the
 * stakes are highest.
 *
 * Refusing without replacing would be useless, so every check returns a
 * correct summary assembled only from records, by concatenation rather than
 * generation. There is always something true to say.
 */

import type { LedgerRecord } from "./chain.ts";
import type { ConfirmedFill } from "../types.ts";

export type Problem =
  | "ungrounded_figure"
  | "ungrounded_reference"
  | "execution_not_confirmed"
  | "unresolved_described_as_done"
  | "omitted_refusal"
  | "omitted_unresolved"
  | "forecast"
  | "advice";

export interface ClaimCheck {
  ok: boolean;
  problems: { kind: Problem; detail: string }[];
  /** Every figure in the text that a record vouches for, and which record. */
  grounded: { figure: string; value: number; seq: number; field: string }[];
  /** A summary built only from records. Always present, even when the text passed. */
  replacement: string;
}

interface Payload {
  planId?: string;
  fingerprint?: string;
  symbol?: string;
  side?: string;
  venue?: string;
  reason?: string;
  fills?: ConfirmedFill[];
  confirmedFills?: ConfirmedFill[];
  submitted?: { reference: string; quoteQty: number }[];
  predictedBps?: number;
  realisedBps?: number | null;
  errorBps?: number | null;
  savingUsd?: number | null;
  savingBps?: number | null;
  outcome?: string;
}

interface Fact {
  seq: number;
  field: string;
  value: number;
}

/**
 * Every figure a record carries, with a dotted path, for grounding.
 *
 * Numeric leaves, obviously. Also digit strings — venue order ids arrive as
 * strings — and any number written inside a record's own text, such as the
 * caps quoted in a refusal reason. A summary that repeats the ledger's own
 * words must not fail the ledger's own check.
 */
function numericFacts(record: LedgerRecord): Fact[] {
  const out: Fact[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "number" && Number.isFinite(v)) out.push({ seq: record.seq, field: path, value: v });
    else if (typeof v === "string") {
      if (/^\d+$/.test(v)) out.push({ seq: record.seq, field: path, value: Number(v) });
      else for (const f of figuresIn(v)) out.push({ seq: record.seq, field: `${path}:text`, value: f.value });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(record.payload, "");
  return out;
}

/** Every identifier a record carries: plan ids, fingerprints, venue references, hashes. */
function identifiers(record: LedgerRecord): string[] {
  const out: string[] = [record.hash];
  const walk = (v: unknown) => {
    if (typeof v === "string" && /^[0-9a-fx]{8,}$/i.test(v)) out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(record.payload);
  return out;
}

/**
 * Numbers as people write them: "$1,000", "8.73 bps", "0.66 BNB", "80k", "20%".
 * The written precision is what the figure is held to.
 */
function figuresIn(text: string): { raw: string; value: number; decimals: number }[] {
  const out: { raw: string; value: number; decimals: number }[] = [];
  const re = /(?<![\w.])\$?(-?\d{1,3}(?:,\d{3})+|-?\d+)(?:\.(\d+))?\s*(k|K)?(?![\w.]*[0-9a-f]{8,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const whole = m[1]!.replace(/,/g, "");
    const frac = m[2] ?? "";
    let value = Number(`${whole}${frac ? "." + frac : ""}`);
    let decimals = frac.length;
    if (m[3]) {
      // "80.1k" is precise to the hundreds: one decimal of thousands.
      value *= 1000;
      decimals = decimals - 3;
    }
    if (!Number.isFinite(value)) continue;
    out.push({ raw: m[0].trim(), value, decimals });
  }
  return out;
}

/**
 * True when `value` written at `decimals` places reads as `written`.
 *
 * Negative decimals mean tens, hundreds, thousands: "80.1k" is -2, so 80,127.99
 * rounds to 80,100 and matches, while 80,500 does not.
 */
function roundsTo(value: number, written: number, decimals: number): boolean {
  if (decimals >= 0) return Number(value.toFixed(decimals)) === written;
  const scale = 10 ** -decimals;
  return Math.round(value / scale) * scale === written;
}

const EXECUTION_WORDS = /\b(bought|sold|filled|executed|traded|swapped|placed an? order|order (?:was|is) (?:done|complete|filled)|completed the (?:buy|sell|order|trade))\b/i;
const REFUSAL_WORDS = /\b(refus\w*|reject\w*|block\w*|declin\w*|fail\w*|did not (?:send|execute|go through)|was not sent|nothing was sent)\b/i;
const UNRESOLVED_WORDS = /\b(unconfirmed|unresolved|pending|could not be established|not yet (?:confirmed|resolved|known)|awaiting)\b/i;
const FORECAST_WORDS = /\b(will (?:rise|fall|go up|go down|climb|drop|double|moon|dump|pump|recover|rally)|(?:is|are) going to (?:rise|fall|go up|go down)|guaranteed?|risk[- ]free|can'?t lose|sure thing)\b/i;
const ADVICE_WORDS = /\b(you should (?:buy|sell|hold|short|long)|(?:i |we )?recommend (?:buying|selling|holding)|(?:buy|sell) (?:now|immediately)|(?:good|great|best) time to (?:buy|sell))\b/i;

/**
 * Check a summary against the ledger.
 *
 * `since` limits which records are the subject of the summary; by default
 * every record counts, because a summary that says "today" while the ledger
 * holds a refusal from an hour ago is still leaving something out.
 */
export function checkClaim(text: string, records: LedgerRecord[], opts: { since?: number } = {}): ClaimCheck {
  const scope = opts.since === undefined ? records : records.filter((r) => Date.parse(r.timestamp) >= opts.since!);
  const problems: ClaimCheck["problems"] = [];
  const grounded: ClaimCheck["grounded"] = [];

  const completed = scope.filter((r) => r.kind === "execution.completed");
  const reconciledFilled = scope.filter(
    (r) => r.kind === "execution.reconciled" && /^(filled|partial)$/.test((r.payload as Payload)?.outcome ?? ""),
  );
  const refusals = scope.filter((r) => r.kind === "execution.refused" || r.kind === "execution.failed");
  const reconciledPlans = new Set(
    scope.filter((r) => r.kind === "execution.reconciled").map((r) => (r.payload as Payload)?.planId),
  );
  const unresolved = scope.filter(
    (r) => r.kind === "execution.unconfirmed" && !reconciledPlans.has((r.payload as Payload)?.planId),
  );
  const fillsDone = [...completed, ...reconciledFilled];

  // 1. Figures. Each one must be vouched for by some record at the precision
  //    written. Counts of records ground small integers too.
  const facts = scope.flatMap(numericFacts);
  const counts: Fact[] = [
    { seq: -1, field: "count.executed", value: fillsDone.length },
    { seq: -1, field: "count.refused", value: refusals.length },
    { seq: -1, field: "count.unresolved", value: unresolved.length },
    { seq: -1, field: "count.records", value: scope.length },
  ];
  for (const fig of figuresIn(text)) {
    const hit =
      facts.find((f) => roundsTo(f.value, fig.value, fig.decimals)) ??
      counts.find((f) => f.value === fig.value && fig.decimals === 0);
    if (hit) grounded.push({ figure: fig.raw, value: fig.value, seq: hit.seq, field: hit.field });
    else {
      problems.push({
        kind: "ungrounded_figure",
        detail: `"${fig.raw}" appears in the summary and no record carries a value that reads as ${fig.raw} at that precision.`,
      });
    }
  }

  // 1b. Identifiers. A plan id or transaction reference has to be one on the record.
  const ids = new Set(scope.flatMap(identifiers));
  for (const token of text.match(/\b(?:0x)?[0-9a-f]{8,}\b/gi) ?? []) {
    if (/^\d+$/.test(token)) continue; // a plain number, handled above
    if (![...ids].some((id) => id.toLowerCase().startsWith(token.toLowerCase()) || token.toLowerCase().startsWith(id.toLowerCase()))) {
      problems.push({
        kind: "ungrounded_reference",
        detail: `"${token}" looks like a plan id, fingerprint or transaction reference, and no record carries it.`,
      });
    }
  }

  // 2. Execution claims need a confirmed fill behind them.
  if (EXECUTION_WORDS.test(text)) {
    if (fillsDone.length === 0) {
      problems.push({
        kind: unresolved.length > 0 ? "unresolved_described_as_done" : "execution_not_confirmed",
        detail:
          unresolved.length > 0
            ? `The summary describes a trade as done, but the only order that left is unresolved: it was sent and the venue has not yet said what became of it.`
            : `The summary describes a trade as done, and no execution reached a confirmed fill. ` +
              (refusals.length > 0 ? `${refusals.length} attempt(s) were refused or failed.` : `Nothing was sent.`),
      });
    }
  }

  // 3/4. Omissions. Silence about a refusal is the lie a word-by-word check
  //      cannot catch, and it is the common one.
  if (refusals.length > 0 && !REFUSAL_WORDS.test(text)) {
    problems.push({
      kind: "omitted_refusal",
      detail: `${refusals.length} order(s) were refused or failed and the summary does not mention it.`,
    });
  }
  if (unresolved.length > 0 && !UNRESOLVED_WORDS.test(text)) {
    problems.push({
      kind: "omitted_unresolved",
      detail: `${unresolved.length} order(s) were sent and never resolved, and the summary does not say so.`,
    });
  }

  // 5. Things no record can support.
  if (FORECAST_WORDS.test(text)) {
    problems.push({ kind: "forecast", detail: "The summary predicts where a price will go. No record can support a forecast." });
  }
  if (ADVICE_WORDS.test(text)) {
    problems.push({ kind: "advice", detail: "The summary recommends a trade. This product routes decisions; it does not make them." });
  }

  return {
    ok: problems.length === 0,
    problems,
    grounded,
    replacement: describe(scope, fillsDone, refusals, unresolved),
  };
}

const bps = (n: number | null | undefined) => (typeof n === "number" ? `${n.toFixed(2)} bps` : "not priced");
const usd = (n: number) => `$${n.toFixed(2)}`;

/** A summary built by concatenating what the records say. Nothing is inferred. */
function describe(
  scope: LedgerRecord[],
  fillsDone: LedgerRecord[],
  refusals: LedgerRecord[],
  unresolved: LedgerRecord[],
): string {
  const lines: string[] = [];

  if (fillsDone.length === 0) {
    lines.push("No order was executed.");
  } else {
    for (const r of fillsDone) {
      const p = r.payload as Payload;
      const fills = (p.fills ?? []).filter((f) => f.status === "FILLED" || f.status === "PARTIAL");
      const base = fills.reduce((a, f) => a + f.filledBaseQty, 0);
      const quote = fills.reduce((a, f) => a + f.filledQuoteQty, 0);
      const refs = fills.map((f) => f.reference).filter(Boolean).join(", ");
      lines.push(
        `${p.side ?? "?"} ${base.toFixed(6)} on ${p.symbol ?? "?"} via ${p.venue ?? fills[0]?.venue ?? "?"} for ${usd(quote)}` +
          (refs ? ` (ref ${refs})` : "") +
          `: predicted ${bps(p.predictedBps)}, realised ${bps(p.realisedBps)}` +
          (typeof p.savingUsd === "number" ? `, ${usd(p.savingUsd)} against the next best route` : "") +
          (r.kind === "execution.reconciled" ? " — confirmed late, by reconciliation" : "") +
          ".",
      );
    }
  }

  for (const r of refusals) {
    const p = r.payload as Payload;
    lines.push(`${r.kind === "execution.failed" ? "Failed" : "Refused"}: ${p.reason ?? "no reason recorded"}`);
  }
  for (const r of unresolved) {
    const p = r.payload as Payload;
    const refs = (p.submitted ?? []).map((s) => s.reference).join(", ");
    lines.push(
      `Unresolved: plan ${p.planId ?? "?"} was sent to the venue (ref ${refs || "?"}) and its outcome has not been established. Its notional is held against the caps until it is reconciled.`,
    );
  }
  if (scope.length === 0) lines.push("The ledger holds no records.");
  return lines.join(" ");
}
