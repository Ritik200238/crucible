/**
 * Policy loading.
 *
 * The policy lives in a file the user owns, not in the agent's context. That
 * separation is the point: an agent can read its limits, but it cannot talk its
 * way past them, because nothing it says is ever written back here.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Market, Policy } from "./types.ts";

export const DEFAULT_CONFIG_PATH = "guardrail.config.json";

/**
 * Deliberately cautious. Someone who runs Guardrail without writing a config
 * should end up over-protected, not under-protected.
 */
export const DEFAULT_POLICY: Policy = {
  version: 1,
  mode: "dry-run",
  maxOrderNotionalUsd: 100,
  maxDailyNotionalUsd: 500,
  maxPositionPctOfEquity: 25,
  maxLeverage: 3,
  dailyLossLimitPct: 2,
  cooldownAfterLossMinutes: 30,
  maxOrdersPerHour: 10,
  confirmAboveNotionalUsd: 50,
  allowedMarkets: ["SPOT"],
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const MARKETS: Market[] = ["SPOT", "MARGIN", "USDM_FUTURES", "COINM_FUTURES"];

function num(v: unknown, field: string, { min = 0 }: { min?: number } = {}): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ConfigError(`${field} must be a finite number.`);
  }
  if (v < min) throw new ConfigError(`${field} must be at least ${min}.`);
  return v;
}

function strArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) {
    throw new ConfigError(`${field} must be an array of strings.`);
  }
  return v as string[];
}

/**
 * Parse and validate a policy.
 *
 * Unknown keys are rejected rather than ignored. A typo like `maxLeverge` that
 * silently disables a limit is precisely the failure this tool exists to prevent,
 * so it fails loudly at load time instead.
 */
export function parsePolicy(raw: unknown): Policy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("Policy must be a JSON object.");
  }
  const o = raw as Record<string, unknown>;
  const policy: Policy = { version: 1, mode: "dry-run" };

  const known = new Set([
    "version", "mode", "maxOrderNotionalUsd", "maxDailyNotionalUsd",
    "maxPositionPctOfEquity", "maxLeverage", "dailyLossLimitPct",
    "symbolAllowlist", "symbolDenylist", "cooldownAfterLossMinutes",
    "maxOrdersPerHour", "confirmAboveNotionalUsd", "noTradeWindowsUtc",
    "allowedMarkets",
  ]);
  const unknown = Object.keys(o).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown policy field(s): ${unknown.join(", ")}. ` +
        `A misspelled rule silently disables it, so Guardrail refuses to load this config.`,
    );
  }

  if (o.version !== undefined) policy.version = num(o.version, "version", { min: 1 });

  if (o.mode !== undefined) {
    if (o.mode !== "dry-run" && o.mode !== "live") {
      throw new ConfigError('mode must be "dry-run" or "live".');
    }
    policy.mode = o.mode;
  }

  if (o.maxOrderNotionalUsd !== undefined)
    policy.maxOrderNotionalUsd = num(o.maxOrderNotionalUsd, "maxOrderNotionalUsd");
  if (o.maxDailyNotionalUsd !== undefined)
    policy.maxDailyNotionalUsd = num(o.maxDailyNotionalUsd, "maxDailyNotionalUsd");
  if (o.maxPositionPctOfEquity !== undefined)
    policy.maxPositionPctOfEquity = num(o.maxPositionPctOfEquity, "maxPositionPctOfEquity");
  if (o.maxLeverage !== undefined)
    policy.maxLeverage = num(o.maxLeverage, "maxLeverage", { min: 1 });
  if (o.dailyLossLimitPct !== undefined)
    policy.dailyLossLimitPct = num(o.dailyLossLimitPct, "dailyLossLimitPct");
  if (o.cooldownAfterLossMinutes !== undefined)
    policy.cooldownAfterLossMinutes = num(o.cooldownAfterLossMinutes, "cooldownAfterLossMinutes");
  if (o.maxOrdersPerHour !== undefined)
    policy.maxOrdersPerHour = num(o.maxOrdersPerHour, "maxOrdersPerHour");
  if (o.confirmAboveNotionalUsd !== undefined)
    policy.confirmAboveNotionalUsd = num(o.confirmAboveNotionalUsd, "confirmAboveNotionalUsd");

  if (o.symbolAllowlist !== undefined)
    policy.symbolAllowlist = strArray(o.symbolAllowlist, "symbolAllowlist");
  if (o.symbolDenylist !== undefined)
    policy.symbolDenylist = strArray(o.symbolDenylist, "symbolDenylist");

  if (o.allowedMarkets !== undefined) {
    const list = strArray(o.allowedMarkets, "allowedMarkets");
    const bad = list.filter((m) => !MARKETS.includes(m as Market));
    if (bad.length > 0) {
      throw new ConfigError(
        `Unknown market(s): ${bad.join(", ")}. Valid: ${MARKETS.join(", ")}.`,
      );
    }
    policy.allowedMarkets = list as Market[];
  }

  if (o.noTradeWindowsUtc !== undefined) {
    if (!Array.isArray(o.noTradeWindowsUtc)) {
      throw new ConfigError("noTradeWindowsUtc must be an array.");
    }
    policy.noTradeWindowsUtc = o.noTradeWindowsUtc.map((w, i) => {
      const win = w as Record<string, unknown>;
      const t = /^\d{1,2}:\d{2}$/;
      if (typeof win.start !== "string" || !t.test(win.start))
        throw new ConfigError(`noTradeWindowsUtc[${i}].start must be "HH:MM".`);
      if (typeof win.end !== "string" || !t.test(win.end))
        throw new ConfigError(`noTradeWindowsUtc[${i}].end must be "HH:MM".`);
      return {
        start: win.start,
        end: win.end,
        ...(typeof win.label === "string" ? { label: win.label } : {}),
      };
    });
  }

  return policy;
}

/** Load a policy from disk, or fall back to the cautious defaults. */
export function loadPolicy(path = DEFAULT_CONFIG_PATH): { policy: Policy; source: string } {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) {
    return { policy: DEFAULT_POLICY, source: "built-in defaults (no config file found)" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(full, "utf8"));
  } catch (err) {
    throw new ConfigError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  return { policy: parsePolicy(raw), source: full };
}

/**
 * Live mode requires a second, separate opt-in via the environment.
 *
 * Setting `"mode": "live"` in a file that an agent could conceivably edit is not
 * enough to move real money. GUARDRAIL_LIVE=1 has to be set in the shell by a
 * human, and both must agree before a single order is transmitted.
 */
export function isLiveEnabled(policy: Policy): boolean {
  return policy.mode === "live" && process.env.GUARDRAIL_LIVE === "1";
}
