/**
 * The audit log.
 *
 * Append-only JSONL, one line per decision. This is the artefact that makes an
 * autonomous agent reviewable after the fact: what it wanted to do, what the
 * rules said, and whether anything was actually transmitted.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Decision } from "./types.ts";
import { STATE_DIR } from "./state/store.ts";

export const AUDIT_PATH = `${STATE_DIR}/audit.jsonl`;

export interface AuditEntry {
  timestamp: string;
  verdict: Decision["verdict"];
  symbol: string;
  side: string;
  market: string;
  notionalUsd: number;
  markPrice: number;
  blockedBy: string[];
  confirmRequiredBy: string[];
  /** Whether an order actually left the machine. False for every dry-run. */
  transmitted: boolean;
  /** Binance order id when transmitted, else null. */
  exchangeOrderId: string | null;
  rules: { rule: string; verdict: string; message: string }[];
}

export function toEntry(
  decision: Decision,
  opts: { transmitted: boolean; exchangeOrderId?: string | null } = { transmitted: false },
): AuditEntry {
  return {
    timestamp: decision.timestamp,
    verdict: decision.verdict,
    symbol: decision.order.symbol,
    side: decision.order.side,
    market: decision.order.market,
    notionalUsd: decision.notionalUsd,
    markPrice: decision.markPrice,
    blockedBy: decision.blockedBy,
    confirmRequiredBy: decision.confirmRequiredBy,
    transmitted: opts.transmitted,
    exchangeOrderId: opts.exchangeOrderId ?? null,
    rules: decision.results.map((r) => ({
      rule: r.rule,
      verdict: r.verdict,
      message: r.message,
    })),
  };
}

export function append(entry: AuditEntry, path = AUDIT_PATH): void {
  const full = resolve(process.cwd(), path);
  mkdirSync(dirname(full), { recursive: true });
  appendFileSync(full, JSON.stringify(entry) + "\n", "utf8");
}

export function read(path = AUDIT_PATH): AuditEntry[] {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) return [];
  return readFileSync(full, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as AuditEntry];
      } catch {
        return []; // Skip a torn line rather than lose the whole log.
      }
    });
}

export interface AuditSummary {
  total: number;
  allowed: number;
  confirmed: number;
  blocked: number;
  transmitted: number;
  notionalBlockedUsd: number;
  topRules: { rule: string; blocks: number }[];
}

/** What the log says, in the form a human actually wants it. */
export function summarise(entries: AuditEntry[]): AuditSummary {
  const counts = new Map<string, number>();
  let notionalBlockedUsd = 0;

  for (const e of entries) {
    if (e.verdict === "BLOCK") {
      notionalBlockedUsd += e.notionalUsd;
      for (const r of e.blockedBy) counts.set(r, (counts.get(r) ?? 0) + 1);
    }
  }

  return {
    total: entries.length,
    allowed: entries.filter((e) => e.verdict === "ALLOW").length,
    confirmed: entries.filter((e) => e.verdict === "CONFIRM").length,
    blocked: entries.filter((e) => e.verdict === "BLOCK").length,
    transmitted: entries.filter((e) => e.transmitted).length,
    notionalBlockedUsd,
    topRules: [...counts.entries()]
      .map(([rule, blocks]) => ({ rule, blocks }))
      .sort((a, b) => b.blocks - a.blocks),
  };
}
