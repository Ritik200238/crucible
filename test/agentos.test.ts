/**
 * Reading the account's real commission through Binance Agent OS.
 *
 * Commission is ten of the eleven basis points on a typical exchange-side quote,
 * so which rate is in use decides the venue on its own. These tests pin three
 * things: where the session token is found and that it is never invented; that
 * the client speaks the protocol as documented, including the event-stream
 * body shape; and that any failure along the way ends in a labelled fallback
 * to the public schedule rather than a wrong number presented as the account's.
 *
 * Nothing here opens a socket. The endpoint cannot be reached from a test
 * without a user's authorisation, and a suite that needed one would be a suite
 * that never runs in CI.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentOsClient,
  AgentOsError,
  BINANCE_MCP_URL,
  fetchAccountCommission,
  findAgentOsToken,
} from "../src/venues/agentos.ts";
import { resetCommissionCache, resolveCommission } from "../src/venues/commission.ts";

const dirs: string[] = [];
afterEach(() => {
  resetCommissionCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function credentialsFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "crucible-agentos-"));
  dirs.push(dir);
  const path = join(dir, ".credentials.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

/** A fake Binance MCP server: records requests, answers from a script. */
function fakeServer(handler: (method: string, params: unknown) => { status?: number; body?: unknown; sse?: boolean }) {
  const requests: { headers: Record<string, string>; method: string; params: unknown }[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const frame = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown };
    requests.push({ headers, method: frame.method, params: frame.params });

    const reply = handler(frame.method, frame.params);
    const status = reply.status ?? 200;
    if (status !== 200) return new Response("", { status });
    const message = { jsonrpc: "2.0", id: frame.id, ...(reply.body as object) };
    if (reply.sse) {
      return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
        status,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify(message), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, requests };
}

const COMMISSION_REPLY = {
  symbol: "BNBUSDT",
  standardCommission: { maker: "0.00075000", taker: "0.00075000", buyer: "0", seller: "0" },
  taxCommission: { maker: "0", taker: "0", buyer: "0", seller: "0" },
  discount: { enabledForAccount: true, enabledForSymbol: true, discountAsset: "BNB", discount: "0.75000000" },
};

const toolResult = (data: unknown) => ({
  result: { content: [{ type: "text", text: JSON.stringify(data) }] },
});

// ---------------------------------------------------------------------------

describe("finding the session token", () => {
  test("the environment wins, so a server or CI can supply it", () => {
    const found = findAgentOsToken({ BINANCE_MCP_TOKEN: "env-token" }, "/nonexistent");
    assert.deepEqual(found, { token: "env-token", source: "env" });
  });

  test("otherwise the token Claude Code stored for this exact server is used", () => {
    const path = credentialsFile({
      mcpOAuth: {
        "github|abc": { serverName: "github", serverUrl: "https://api.githubcopilot.com/mcp/", accessToken: "not-this" },
        "binance-mcp-server|def": { serverName: "binance-mcp-server", serverUrl: BINANCE_MCP_URL, accessToken: "binance-token" },
      },
    });
    const found = findAgentOsToken({}, path);
    assert.deepEqual(found, { token: "binance-token", source: "claude-code" });
  });

  test("a token for a different server is never mistaken for Binance's", () => {
    // The store is keyed by server, and a token for another service sent to
    // Binance would be a credential leak as well as a wrong answer.
    const path = credentialsFile({
      mcpOAuth: { "other|x": { serverUrl: "https://evil.example/mcp/agentic", accessToken: "t" } },
    });
    assert.equal(findAgentOsToken({}, path), null);
  });

  test("no file, an unreadable file, or an empty entry all mean no session", () => {
    assert.equal(findAgentOsToken({}, "/definitely/not/here.json"), null);
    assert.equal(findAgentOsToken({}, credentialsFile("{not json")), null);
    assert.equal(findAgentOsToken({}, credentialsFile({ mcpOAuth: { "b|1": { serverUrl: BINANCE_MCP_URL, accessToken: "" } } })), null);
  });

  test("a blank environment token does not shadow the stored one", () => {
    const path = credentialsFile({ mcpOAuth: { "b|1": { serverUrl: BINANCE_MCP_URL, accessToken: "stored" } } });
    assert.equal(findAgentOsToken({ BINANCE_MCP_TOKEN: "   " }, path)?.token, "stored");
  });
});

describe("speaking to the server", () => {
  test("every request carries the bearer token and accepts both body formats", async () => {
    const server = fakeServer(() => ({ body: { result: { tools: [] } } }));
    const client = new AgentOsClient("tok-123", { fetchImpl: server.fetchImpl });
    await client.listTools();

    const req = server.requests[0]!;
    assert.equal(req.headers.authorization, "Bearer tok-123");
    assert.match(req.headers.accept, /application\/json/);
    assert.match(req.headers.accept, /text\/event-stream/);
    assert.equal(req.method, "tools/list");
  });

  test("an event-stream body is read as well as a JSON one", async () => {
    const server = fakeServer(() => ({ sse: true, body: { result: { tools: [{ name: "spot.accountCommission" }] } } }));
    const client = new AgentOsClient("t", { fetchImpl: server.fetchImpl });
    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["spot.accountCommission"]);
  });

  test("a listed tool is called directly; an unlisted one goes through tool_execute", async () => {
    const server = fakeServer((method) =>
      method === "tools/list"
        ? { body: { result: { tools: [{ name: "spot.ticker" }] } } }
        : { body: toolResult({ ok: true }) },
    );
    const client = new AgentOsClient("t", { fetchImpl: server.fetchImpl });

    await client.callTool("spot.ticker", { symbol: "BNBUSDT" });
    await client.callTool("spot.accountCommission", { symbol: "BNBUSDT" });

    const calls = server.requests.filter((r) => r.method === "tools/call").map((r) => r.params as { name: string; arguments: unknown });
    assert.deepEqual(calls[0], { name: "spot.ticker", arguments: { symbol: "BNBUSDT" } });
    assert.deepEqual(calls[1], {
      name: "tool_execute",
      arguments: { toolName: "spot.accountCommission", arguments: { symbol: "BNBUSDT" } },
    });
  });

  test("a 401 says the session expired and how to reconnect, never retries blindly", async () => {
    const server = fakeServer(() => ({ status: 401 }));
    const client = new AgentOsClient("stale", { fetchImpl: server.fetchImpl });
    await assert.rejects(client.listTools(), (err: unknown) => {
      assert.ok(err instanceof AgentOsError);
      assert.match(err.message, /expired or was revoked/);
      assert.match(err.message, /\/mcp/);
      return true;
    });
    assert.equal(server.requests.length, 1);
  });

  test("a JSON-RPC error is surfaced with its code", async () => {
    const server = fakeServer(() => ({ body: { error: { code: -32601, message: "Method not found" } } }));
    const client = new AgentOsClient("t", { fetchImpl: server.fetchImpl });
    await assert.rejects(client.listTools(), /Method not found \(-32601\)/);
  });

  test("a tool that reports isError is an error, not a result", async () => {
    const server = fakeServer((method) =>
      method === "tools/list"
        ? { body: { result: { tools: [{ name: "x" }] } } }
        : { body: { result: { isError: true, content: [{ type: "text", text: "scope not granted" }] } } },
    );
    const client = new AgentOsClient("t", { fetchImpl: server.fetchImpl });
    await assert.rejects(client.callTool("x", {}), /scope not granted/);
  });
});

describe("reading the commission", () => {
  test("the documented shape is decoded into fractions, with the discount reported", async () => {
    const server = fakeServer((method) =>
      method === "tools/list"
        ? { body: { result: { tools: [{ name: "spot.accountCommission" }] } } }
        : { body: toolResult(COMMISSION_REPLY) },
    );
    const c = await fetchAccountCommission(new AgentOsClient("t", { fetchImpl: server.fetchImpl }), "bnbusdt");
    assert.ok(c);
    assert.equal(c.maker, 0.00075);
    assert.equal(c.taker, 0.00075);
    assert.deepEqual(c.discount, { enabled: true, rate: 0.75 });
    // The symbol is sent upper-cased, as the exchange expects it.
    const call = server.requests.find((r) => r.method === "tools/call")!.params as { arguments: { symbol: string } };
    assert.equal(call.arguments.symbol, "BNBUSDT");
  });

  test("a reply missing the rates is refused rather than read as zero", async () => {
    // Zero commission would make the exchange the cheapest venue at every size.
    const server = fakeServer((method) =>
      method === "tools/list"
        ? { body: { result: { tools: [{ name: "spot.accountCommission" }] } } }
        : { body: toolResult({ symbol: "BNBUSDT" }) },
    );
    await assert.rejects(
      fetchAccountCommission(new AgentOsClient("t", { fetchImpl: server.fetchImpl }), "BNBUSDT"),
      /did not carry standardCommission/,
    );
  });

  test("a rate of one or more is refused as a misread", async () => {
    const server = fakeServer((method) =>
      method === "tools/list"
        ? { body: { result: { tools: [{ name: "spot.accountCommission" }] } } }
        : { body: toolResult({ ...COMMISSION_REPLY, standardCommission: { maker: "10", taker: "10" } }) },
    );
    await assert.rejects(
      fetchAccountCommission(new AgentOsClient("t", { fetchImpl: server.fetchImpl }), "BNBUSDT"),
      /Implausible commission/,
    );
  });

  test("a server that knows no such tool yields null, not an error", async () => {
    // The Account scope may simply not have been granted. That is a reason to
    // fall back, not a reason to fail the quote.
    const server = fakeServer((method) =>
      method === "tools/list"
        ? { body: { result: { tools: [{ name: "spot.ticker" }] } } }
        : { body: { error: { code: -32602, message: "Unknown tool: spot.accountCommission" } } },
    );
    const c = await fetchAccountCommission(new AgentOsClient("t", { fetchImpl: server.fetchImpl }), "BNBUSDT");
    assert.equal(c, null);
  });
});

describe("which rate a quote is priced with", () => {
  const noToken = () => null;
  const withToken = () => ({ token: "t", source: "claude-code" as const });

  test("with no session and no key, the public schedule is used and says why", async () => {
    const rates = await resolveCommission("BNBUSDT", { findToken: noToken, env: {} });
    assert.equal(rates.source, "vip0-default");
    assert.equal(rates.maker, 0.001);
    assert.match(rates.detail ?? "", /No Agent OS session/);
    assert.match(rates.detail ?? "", /claude mcp add binance-mcp-server/);
  });

  test("with a session, the account's rate is used and labelled as coming through Agent OS", async () => {
    const server = fakeServer((method) =>
      method === "tools/list"
        ? { body: { result: { tools: [{ name: "spot.accountCommission" }] } } }
        : { body: toolResult(COMMISSION_REPLY) },
    );
    const rates = await resolveCommission("BNBUSDT", { findToken: withToken, fetchImpl: server.fetchImpl, env: {} });
    assert.equal(rates.source, "account");
    assert.equal(rates.via, "agent-os");
    assert.equal(rates.taker, 0.00075);
    assert.match(rates.detail ?? "", /through Binance Agent OS/);
  });

  test("a session that has expired falls back, and the reason names the reconnect step", async () => {
    // Never a wrong number. An expired session is reported, and the quote is
    // priced at the schedule with the reason attached.
    const server = fakeServer(() => ({ status: 401 }));
    const rates = await resolveCommission("BNBUSDT", { findToken: withToken, fetchImpl: server.fetchImpl, env: {} });
    assert.equal(rates.source, "vip0-default");
    assert.match(rates.detail ?? "", /expired or was revoked/);
  });

  test("the answer is cached per symbol for an hour", async () => {
    let calls = 0;
    const server = fakeServer((method) => {
      calls++;
      return method === "tools/list"
        ? { body: { result: { tools: [{ name: "spot.accountCommission" }] } } }
        : { body: toolResult(COMMISSION_REPLY) };
    });
    const opts = { findToken: withToken, fetchImpl: server.fetchImpl, env: {} };
    await resolveCommission("BNBUSDT", { ...opts, now: 1_000_000 });
    const before = calls;
    await resolveCommission("BNBUSDT", { ...opts, now: 1_000_000 + 30 * 60 * 1000 });
    assert.equal(calls, before, "inside the hour, no second round trip");
    await resolveCommission("BNBUSDT", { ...opts, now: 1_000_000 + 61 * 60 * 1000 });
    assert.ok(calls > before, "past the hour it asks again");
  });

  test("a different symbol is not served from another symbol's cache", async () => {
    const asked: string[] = [];
    const server = fakeServer((method, params) => {
      if (method === "tools/call") asked.push((params as { arguments: { symbol: string } }).arguments.symbol);
      return method === "tools/list"
        ? { body: { result: { tools: [{ name: "spot.accountCommission" }] } } }
        : { body: toolResult(COMMISSION_REPLY) };
    });
    const opts = { findToken: withToken, fetchImpl: server.fetchImpl, env: {} };
    await resolveCommission("BNBUSDT", opts);
    await resolveCommission("ETHUSDT", opts);
    assert.deepEqual(asked, ["BNBUSDT", "ETHUSDT"]);
  });
});
