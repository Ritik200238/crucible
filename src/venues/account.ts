/**
 * The account's real equity, read through Binance Agent OS.
 *
 * The risk engine's concentration and daily-loss rules are fractions of
 * equity, and equity had no source: every caller passed a hardcoded figure, so
 * "25% of your account" was 25% of a number nobody had checked. This reads the
 * real balances through the exchange's own MCP server — the same authorised
 * session that already supplies the commission rate — and values them in the
 * quote asset, so the caps mean what they say.
 *
 * It is a best-effort read. A missing session, an ungranted account scope, or
 * an empty sub-account all mean "no figure available", and the caller keeps
 * whatever default it would have used. A wrong equity is worse than an assumed
 * one: it would loosen a cap silently. So an unusable balance is refused rather
 * than guessed at.
 */

import { AgentOsClient, AgentOsError, findAgentOsToken } from "./agentos.ts";
import { fetchMid } from "./binance.ts";

/** Balances that are stablecoins are already in quote terms; the rest are priced. */
const STABLE = new Set(["USDT", "USDC", "FDUSD", "TUSD", "DAI", "USDP"]);

/** The account tool is not in the listed 50; it is reached through tool_execute. */
const ACCOUNT_TOOL = "spot.getAccount";

interface RawBalance {
  asset: string;
  free: string | number;
  locked: string | number;
}

export interface AccountEquity {
  /** Total value of the spot balances, in the quote asset. */
  equityUsd: number;
  /** Assets that made it up, largest first, for the status screen. */
  holdings: { asset: string; amount: number; valueUsd: number }[];
  /** Assets held but not priceable against USDT, so left out of the total. */
  unpriced: string[];
}

/**
 * Read the account's spot equity in USDT terms.
 *
 * Returns null when there is no session to read it through — the normal case
 * on a machine that has not authorised Agent OS. Throws only when a session
 * exists and answers with something that cannot be trusted, because falling
 * back to a default is safe and using a wrong number is not.
 */
export async function fetchAccountEquity(
  opts: { findToken?: typeof findAgentOsToken; fetchImpl?: typeof fetch; priceOf?: (symbol: string) => Promise<number> } = {},
): Promise<AccountEquity | null> {
  const token = (opts.findToken ?? findAgentOsToken)();
  if (!token) return null;

  const client = new AgentOsClient(token.token, opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {});
  let raw: unknown;
  try {
    raw = await client.callTool(ACCOUNT_TOOL, {});
  } catch (err) {
    // No account scope, or the tool is gone. A read the session cannot make is
    // not an error worth failing a quote over; the caller keeps its default.
    if (err instanceof AgentOsError && /not found|unknown|scope|forbidden/i.test(err.message)) return null;
    throw err;
  }

  const balances = (raw as { balances?: RawBalance[] })?.balances;
  if (!Array.isArray(balances)) {
    throw new AgentOsError(
      `The account reply carried no balances array, so equity cannot be read: ${JSON.stringify(raw).slice(0, 160)}`,
    );
  }

  const priceOf = opts.priceOf ?? fetchMid;
  const held = balances
    .map((b) => ({ asset: b.asset.toUpperCase(), amount: Number(b.free) + Number(b.locked) }))
    .filter((b) => b.amount > 0 && Number.isFinite(b.amount));

  const holdings: AccountEquity["holdings"] = [];
  const unpriced: string[] = [];
  let equityUsd = 0;

  for (const b of held) {
    if (STABLE.has(b.asset)) {
      holdings.push({ asset: b.asset, amount: b.amount, valueUsd: b.amount });
      equityUsd += b.amount;
      continue;
    }
    let price: number;
    try {
      price = await priceOf(`${b.asset}USDT`);
    } catch {
      // A coin with no USDT market cannot be valued from here. It is left out
      // of the total and named, rather than counted at a guessed price.
      unpriced.push(b.asset);
      continue;
    }
    if (!(price > 0)) {
      unpriced.push(b.asset);
      continue;
    }
    const valueUsd = b.amount * price;
    holdings.push({ asset: b.asset, amount: b.amount, valueUsd });
    equityUsd += valueUsd;
  }

  holdings.sort((a, b) => b.valueUsd - a.valueUsd);
  return { equityUsd, holdings, unpriced };
}
