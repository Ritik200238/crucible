/**
 * Reading real account equity through Agent OS.
 *
 * The risk engine's concentration and loss caps are fractions of equity, so a
 * wrong equity silently loosens a cap. The property that matters here is not
 * that it reads a balance — it is that every path which cannot produce a
 * trustworthy figure produces none, and the caller keeps its safe default.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { fetchAccountEquity } from "../src/venues/account.ts";
import { resetCommissionCache } from "../src/venues/commission.ts";

afterEach(() => resetCommissionCache());

const withToken = () => ({ token: "t", source: "claude-code" as const });
const noToken = () => null;

/** A fake MCP server that answers spot.getAccount with a chosen balance set. */
function serverWith(balances: unknown, opts: { status?: number; notFound?: boolean } = {}) {
  const fetchImpl: typeof fetch = async (_input, init) => {
    const frame = JSON.parse(String(init?.body)) as { id: number; method: string; params?: { name?: string; arguments?: { toolName?: string } } };
    const reply = (body: object) => new Response(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...body }), { status: 200, headers: { "content-type": "application/json" } });

    if (frame.method === "initialize") return reply({ result: { serverInfo: { name: "fake" } } });
    if (frame.method === "tools/list") return reply({ result: { tools: [{ name: "spot.deleteOpenOrders" }] } });
    if (frame.method === "tools/call") {
      if (opts.notFound) return reply({ error: { code: -32601, message: "Tool not found: 'spot.getAccount'. Call tool_search" } });
      return reply({ result: { content: [{ type: "text", text: JSON.stringify({ balances }) }] } });
    }
    return reply({ result: {} });
  };
  return fetchImpl;
}

const priceOf = async (symbol: string): Promise<number> => {
  const table: Record<string, number> = { BNBUSDT: 750, ETHUSDT: 2500, BTCUSDT: 100_000 };
  const price = table[symbol];
  if (price === undefined) throw new Error(`no market for ${symbol}`);
  return price;
};

describe("no figure rather than a wrong one", () => {
  test("no session means no equity, and no attempt to read it", async () => {
    const equity = await fetchAccountEquity({ findToken: noToken });
    assert.equal(equity, null);
  });

  test("a session without the account scope falls back rather than failing", async () => {
    const equity = await fetchAccountEquity({ findToken: withToken, fetchImpl: serverWith(null, { notFound: true }), priceOf });
    assert.equal(equity, null);
  });

  test("a reply with no balances array is refused, not read as zero", async () => {
    // Zero equity would make every concentration cap trivially fail closed,
    // which looks safe but is a wrong number driving the rules.
    await assert.rejects(
      fetchAccountEquity({ findToken: withToken, fetchImpl: serverWith(undefined), priceOf }),
      /carried no balances array/,
    );
  });
});

describe("valuing what is held", () => {
  test("stablecoins count at face, other assets at their USDT price", async () => {
    const balances = [
      { asset: "USDT", free: "1000", locked: "0" },
      { asset: "BNB", free: "2", locked: "0" },
      { asset: "ETH", free: "0.5", locked: "0" },
    ];
    const equity = await fetchAccountEquity({ findToken: withToken, fetchImpl: serverWith(balances), priceOf });
    assert.ok(equity);
    // 1000 + 2*750 + 0.5*2500 = 3750
    assert.equal(equity.equityUsd, 3750);
    assert.deepEqual(equity.holdings.map((h) => h.asset), ["BNB", "ETH", "USDT"]);
  });

  test("free and locked are both counted", async () => {
    const equity = await fetchAccountEquity({ findToken: withToken, fetchImpl: serverWith([{ asset: "USDT", free: "600", locked: "400" }]), priceOf });
    assert.equal(equity!.equityUsd, 1000);
  });

  test("a coin with no USDT market is named and left out, not guessed", async () => {
    // Counting it at a made-up price would inflate equity and loosen every cap.
    const balances = [
      { asset: "USDT", free: "500", locked: "0" },
      { asset: "SOMECOIN", free: "1000000", locked: "0" },
    ];
    const equity = await fetchAccountEquity({ findToken: withToken, fetchImpl: serverWith(balances), priceOf });
    assert.equal(equity!.equityUsd, 500, "the unpriceable coin adds nothing");
    assert.deepEqual(equity!.unpriced, ["SOMECOIN"]);
  });

  test("dust and zero balances are ignored", async () => {
    const balances = [
      { asset: "USDT", free: "100", locked: "0" },
      { asset: "BNB", free: "0", locked: "0" },
    ];
    const equity = await fetchAccountEquity({ findToken: withToken, fetchImpl: serverWith(balances), priceOf });
    assert.equal(equity!.equityUsd, 100);
    assert.equal(equity!.holdings.length, 1);
  });

  test("an empty account is real equity of zero, not an error", async () => {
    // The Agentic sub-account starts empty; that is a fact about the account,
    // not a failure to read it.
    const equity = await fetchAccountEquity({ findToken: withToken, fetchImpl: serverWith([]), priceOf });
    assert.ok(equity);
    assert.equal(equity.equityUsd, 0);
    assert.deepEqual(equity.holdings, []);
  });
});
