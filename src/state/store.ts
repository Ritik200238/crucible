/**
 * Rolling state.
 *
 * Time-based rules need memory: a cooldown means nothing without knowing when
 * the last loss happened, and a daily cap means nothing without knowing what has
 * already been spent. This keeps that memory in a small JSON file next to the
 * project, and rolls the daily counters over at 00:00 UTC.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { GuardrailState } from "../types.ts";

export const STATE_DIR = ".guardrail";
export const STATE_PATH = `${STATE_DIR}/state.json`;

export function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function emptyState(now: Date): GuardrailState {
  return {
    day: utcDayKey(now),
    notionalTodayUsd: 0,
    ordersToday: 0,
    recentOrderTimes: [],
    lastLossAt: null,
    realisedPnlTodayUsd: 0,
  };
}

/**
 * Roll the day over if the UTC date has changed.
 *
 * `lastLossAt` deliberately survives the rollover - a cooldown that expires just
 * because the clock passed midnight would be a hole in the rule, not a feature.
 * Hourly order times survive too, and are pruned by age rather than by date.
 */
export function rollIfNeeded(state: GuardrailState, now: Date): GuardrailState {
  const today = utcDayKey(now);
  if (state.day === today) return state;
  return {
    ...emptyState(now),
    lastLossAt: state.lastLossAt,
    recentOrderTimes: pruneOrderTimes(state.recentOrderTimes, now),
  };
}

/** Keep only the last hour of order timestamps. Bounds the file size too. */
export function pruneOrderTimes(times: string[], now: Date): string[] {
  const cutoff = now.getTime() - 3_600_000;
  return times.filter((t) => {
    const ms = new Date(t).getTime();
    return Number.isFinite(ms) && ms >= cutoff;
  });
}

export function loadState(now: Date, path = STATE_PATH): GuardrailState {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) return emptyState(now);
  try {
    const parsed = JSON.parse(readFileSync(full, "utf8")) as GuardrailState;
    return rollIfNeeded(parsed, now);
  } catch {
    // A corrupt state file must not wedge the tool. Starting from zero is the
    // conservative failure: every counter reads as unused, so caps apply in full.
    return emptyState(now);
  }
}

export function saveState(state: GuardrailState, path = STATE_PATH): void {
  const full = resolve(process.cwd(), path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** Record that an order was actually sent. Only called on real transmission. */
export function recordOrder(
  state: GuardrailState,
  notionalUsd: number,
  now: Date,
): GuardrailState {
  return {
    ...rollIfNeeded(state, now),
    notionalTodayUsd: state.notionalTodayUsd + notionalUsd,
    ordersToday: state.ordersToday + 1,
    recentOrderTimes: [...pruneOrderTimes(state.recentOrderTimes, now), now.toISOString()],
  };
}

/** Record realised PnL, arming the cooldown when the trade was a loss. */
export function recordPnl(
  state: GuardrailState,
  pnlUsd: number,
  now: Date,
): GuardrailState {
  const rolled = rollIfNeeded(state, now);
  return {
    ...rolled,
    realisedPnlTodayUsd: rolled.realisedPnlTodayUsd + pnlUsd,
    lastLossAt: pnlUsd < 0 ? now.toISOString() : rolled.lastLossAt,
  };
}
