/**
 * Which commission rate a quote is priced with, and where it came from.
 *
 * Three sources, tried in order, and the answer always says which one it was:
 *
 *   1. Binance Agent OS. The exchange's own MCP server, authorised once by the
 *      user from their own client. No key on this machine.
 *   2. An API key in the environment. The signed REST endpoint for the same
 *      figure, when the operator runs with credentials.
 *   3. The public VIP 0 schedule. Labelled as such on every report, because a
 *      quote that quietly assumed the highest tier would overstate the
 *      exchange's cost on every account that pays less — which is most of them.
 *
 * The first two are the account's real rate and are reported identically. The
 * third is an assumption, and the whole reporting layer keys off that.
 *
 * Nothing here throws. A failure at any source is folded into the fallback's
 * detail string so the quote still prices, and the operator can see on the
 * status screen why their real rate was not used.
 */

import { BinanceRest, credentialsFromEnv, DEMO } from "../exec/binance-rest.ts";
import { VIP0 } from "./binance.ts";
import { AgentOsClient, AgentOsError, fetchAccountCommission, findAgentOsToken } from "./agentos.ts";
import type { CommissionRates } from "../types.ts";

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; rates: CommissionRates }>();

/** Clears the cache. For tests, and after a sign-in. */
export function resetCommissionCache(): void {
  cache.clear();
}

export interface ResolveOptions {
  now?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the credential store lookup. */
  findToken?: typeof findAgentOsToken;
}

export async function resolveCommission(
  symbol: string,
  opts: ResolveOptions = {},
): Promise<CommissionRates> {
  const now = opts.now ?? Date.now();
  const key = symbol.toUpperCase();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.rates;

  const rates = await lookup(key, opts);
  cache.set(key, { at: now, rates });
  return rates;
}

async function lookup(symbol: string, opts: ResolveOptions): Promise<CommissionRates> {
  const env = opts.env ?? process.env;
  const reasons: string[] = [];

  // 1. Agent OS.
  const token = (opts.findToken ?? findAgentOsToken)(env);
  if (token) {
    try {
      const client = new AgentOsClient(token.token, opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {});
      const c = await fetchAccountCommission(client, symbol);
      if (c) {
        return {
          maker: c.maker,
          taker: c.taker,
          source: "account",
          via: "agent-os",
          detail:
            `Read from your account through Binance Agent OS (session from ${token.source === "env" ? "BINANCE_MCP_TOKEN" : "Claude Code"}).` +
            (c.discount?.enabled ? ` BNB fee discount of ${(c.discount.rate * 100).toFixed(0)}% is on; not applied here.` : ""),
        };
      }
      reasons.push("Agent OS session found, but it offers no account-commission tool — the Account scope may not be granted.");
    } catch (err) {
      reasons.push(err instanceof AgentOsError ? err.message : `Agent OS: ${(err as Error).message}`);
    }
  } else {
    reasons.push("No Agent OS session. Connect one: claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic, then authenticate in /mcp.");
  }

  // 2. An API key. Read from the process environment by the same function the
  // execution path uses, so the key that would sign an order is the key whose
  // rate is quoted.
  try {
    const credentials = credentialsFromEnv();
    const baseUrl = process.env.CRUCIBLE_BINANCE_BASE ?? DEMO;
    const client = new BinanceRest({
      baseUrl,
      credentials,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    const c = await client.accountCommission(symbol);
    return {
      maker: c.maker,
      taker: c.taker,
      source: "account",
      via: "api-key",
      detail: `Read from your account with the API key in the environment (${baseUrl}).`,
    };
  } catch (err) {
    const message = (err as Error).message;
    reasons.push(/BINANCE_API_KEY/.test(message) ? "No API key in the environment." : `API key: ${message}`);
  }

  // 3. The public schedule.
  return {
    ...VIP0,
    detail: `Public VIP 0 schedule. ${reasons.join(" ")}`,
  };
}
