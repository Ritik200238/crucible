/**
 * Policy loading.
 *
 * The policy lives in a file the operator owns, not in the agent's context. An
 * agent can read its limits and explain them; it cannot talk its way past them,
 * because nothing it says is ever written back here.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Market, Policy, Venue } from "./types.ts";

export const DEFAULT_CONFIG_PATH = "crucible.config.json";

/**
 * Deliberately cautious.
 *
 * Someone who runs this without writing a config should end up over-protected.
 * The execution limits are set where they actually bite on a liquid pair: 25 bps
 * of impact is roughly a $250,000 order on the deepest book here, and a
 * five-second snapshot age is about as long as a quote at these margins means
 * anything.
 */
export const DEFAULT_POLICY: Policy = {
  version: 1,
  mode: "dry-run",

  maxOrderNotionalUsd: 25_000,
  maxDailyNotionalUsd: 100_000,
  maxPositionPctOfEquity: 25,
  dailyLossLimitPct: 2,
  cooldownAfterLossMinutes: 30,
  maxOrdersPerHour: 20,
  confirmAboveNotionalUsd: 5_000,
  allowedMarkets: ["SPOT"],

  maxImpactBps: 25,
  maxSlippageBps: 50,
  minDepthNotionalUsd: 10_000,
  depthWindowBps: 50,
  snapshotMaxAgeMs: 5_000,
  venueAllowlist: ["BINANCE_SPOT", "ONCHAIN"],
  maxQuoteDisagreementBps: 50,
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const MARKETS: Market[] = ["SPOT", "MARGIN", "USDM_FUTURES", "COINM_FUTURES"];
const VENUES: Venue[] = ["BINANCE_SPOT", "ONCHAIN"];

const NUMERIC_FIELDS = [
  "maxOrderNotionalUsd",
  "maxDailyNotionalUsd",
  "maxPositionPctOfEquity",
  "maxLeverage",
  "dailyLossLimitPct",
  "cooldownAfterLossMinutes",
  "maxOrdersPerHour",
  "confirmAboveNotionalUsd",
  "maxImpactBps",
  "maxSlippageBps",
  "minDepthNotionalUsd",
  "depthWindowBps",
  "snapshotMaxAgeMs",
  "maxQuoteDisagreementBps",
] as const;

const KNOWN = new Set<string>([
  "version",
  "mode",
  "symbolAllowlist",
  "symbolDenylist",
  "noTradeWindowsUtc",
  "allowedMarkets",
  "venueAllowlist",
  ...NUMERIC_FIELDS,
]);

function num(v: unknown, field: string, min = 0): number {
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
 * Parse and validate.
 *
 * Unknown keys are rejected rather than ignored. A misspelling like `maxImpactBP`
 * that silently disables a limit is precisely the failure this tool exists to
 * prevent, so it fails loudly at load time instead of quietly at execution time.
 */
export function parsePolicy(raw: unknown): Policy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("The policy file must contain a JSON object.");
  }
  const o = raw as Record<string, unknown>;

  const unknown = Object.keys(o).filter((k) => !KNOWN.has(k));
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown policy field(s): ${unknown.join(", ")}. A misspelled rule silently disables it, ` +
        `so this config is refused rather than partly applied. Valid fields: ${[...KNOWN].sort().join(", ")}.`,
    );
  }

  const policy: Policy = { version: 1, mode: "dry-run" };

  if (o.version !== undefined) policy.version = num(o.version, "version", 1);

  if (o.mode !== undefined) {
    if (o.mode !== "dry-run" && o.mode !== "live") {
      throw new ConfigError('mode must be "dry-run" or "live".');
    }
    policy.mode = o.mode;
  }

  for (const field of NUMERIC_FIELDS) {
    if (o[field] !== undefined) {
      // Leverage below 1 is not leverage; every other limit may legitimately be
      // set to zero to mean "refuse everything".
      const min = field === "maxLeverage" ? 1 : 0;
      // Policy has no index signature, so the write goes through a mutable view.
      // The field name comes from NUMERIC_FIELDS, which is derived from Policy's
      // own numeric keys, so the assignment is type-correct by construction.
      (policy as unknown as Record<string, number>)[field] = num(o[field], field, min);
    }
  }

  if (o.symbolAllowlist !== undefined) {
    policy.symbolAllowlist = strArray(o.symbolAllowlist, "symbolAllowlist");
  }
  if (o.symbolDenylist !== undefined) {
    policy.symbolDenylist = strArray(o.symbolDenylist, "symbolDenylist");
  }

  if (o.allowedMarkets !== undefined) {
    const list = strArray(o.allowedMarkets, "allowedMarkets");
    const bad = list.filter((m) => !MARKETS.includes(m as Market));
    if (bad.length > 0) {
      throw new ConfigError(`Unknown market(s): ${bad.join(", ")}. Valid: ${MARKETS.join(", ")}.`);
    }
    policy.allowedMarkets = list as Market[];
  }

  if (o.venueAllowlist !== undefined) {
    const list = strArray(o.venueAllowlist, "venueAllowlist");
    const bad = list.filter((v) => !VENUES.includes(v as Venue));
    if (bad.length > 0) {
      throw new ConfigError(`Unknown venue(s): ${bad.join(", ")}. Valid: ${VENUES.join(", ")}.`);
    }
    policy.venueAllowlist = list as Venue[];
  }

  if (o.noTradeWindowsUtc !== undefined) {
    if (!Array.isArray(o.noTradeWindowsUtc)) {
      throw new ConfigError("noTradeWindowsUtc must be an array.");
    }
    policy.noTradeWindowsUtc = o.noTradeWindowsUtc.map((w, i) => {
      const win = w as Record<string, unknown>;
      const pattern = /^\d{1,2}:\d{2}$/;
      if (typeof win.start !== "string" || !pattern.test(win.start)) {
        throw new ConfigError(`noTradeWindowsUtc[${i}].start must be "HH:MM".`);
      }
      if (typeof win.end !== "string" || !pattern.test(win.end)) {
        throw new ConfigError(`noTradeWindowsUtc[${i}].end must be "HH:MM".`);
      }
      return {
        start: win.start,
        end: win.end,
        ...(typeof win.label === "string" ? { label: win.label } : {}),
      };
    });
  }

  if (policy.depthWindowBps !== undefined && policy.minDepthNotionalUsd === undefined) {
    throw new ConfigError(
      "depthWindowBps only means something alongside minDepthNotionalUsd. Set both, or neither.",
    );
  }

  return policy;
}

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
 * Live execution needs two independent switches.
 *
 * `"mode": "live"` in a file an agent could conceivably edit is not on its own
 * enough to move real money. `CRUCIBLE_LIVE=1` has to be set in the shell by a
 * human, and both must agree before a single order is transmitted.
 */
export function isLiveEnabled(policy: Policy): boolean {
  return policy.mode === "live" && process.env.CRUCIBLE_LIVE === "1";
}
