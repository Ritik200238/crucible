/**
 * The MCP server over HTTP: the same tools, hostable, and safe to hand out.
 *
 * Two properties. First, an agent pointed at the URL gets exactly the tools
 * the stdio server offers, over the documented transport, with nothing lost in
 * the change of pipe. Second, a public instance is read-only to anyone without
 * the operator's token — every read tool answers, and the two tools that can
 * move money refuse with a reason. That second property is what makes it
 * possible to publish the URL at all.
 *
 * The server is started on an ephemeral loopback port. No fixture, no mock:
 * these are real HTTP requests against the real handler.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

import { startDashboard } from "../src/dashboard/server.ts";

let server: Server;
let base: string;
const savedToken = process.env.CRUCIBLE_MCP_TOKEN;
const OPERATOR = "operator-secret-for-tests";

before(async () => {
  process.env.CRUCIBLE_MCP_TOKEN = OPERATOR;
  server = await startDashboard(0);
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (savedToken === undefined) delete process.env.CRUCIBLE_MCP_TOKEN;
  else process.env.CRUCIBLE_MCP_TOKEN = savedToken;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Reply {
  result?: { tools?: { name: string }[]; content?: { text?: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}

let nextId = 1;
async function rpc(method: string, params?: unknown, token?: string): Promise<{ status: number; reply: Reply }> {
  const id = nextId++;
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  let reply: Reply = {};
  try {
    reply = JSON.parse(text) as Reply;
  } catch {
    // An SSE body would land here; the server is asked for JSON, so it is a failure.
    throw new Error(`non-JSON reply (${res.status}): ${text.slice(0, 200)}`);
  }
  return { status: res.status, reply };
}

const textOf = (r: Reply) => r.result?.content?.[0]?.text ?? "";

describe("the transport", () => {
  test("initialize is answered stateless — no session id to carry", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("mcp-session-id"), null, "a stateless server issues no session");
    const body = (await res.json()) as { result?: { serverInfo?: { name?: string } } };
    assert.ok(body.result?.serverInfo?.name, "serverInfo must be present");
  });

  test("the same nine tools as the stdio server", async () => {
    const { reply } = await rpc("tools/list");
    const names = (reply.result?.tools ?? []).map((t) => t.name).sort();
    assert.deepEqual(names, [
      "calibration",
      "evidence",
      "execute",
      "policy",
      "quote",
      "reconcile",
      "route",
      "status",
      "verify_ledger",
    ]);
  });

  test("GET is refused in the protocol's own terms", async () => {
    const res = await fetch(`${base}/mcp`);
    assert.equal(res.status, 405);
    const body = (await res.json()) as { error?: { message?: string } };
    assert.match(body.error?.message ?? "", /stateless/);
  });

  test("a body that is not JSON is a parse error, not a crash", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", body: "{nope", headers: { "content-type": "application/json" } });
    assert.equal(res.status, 400);
    const { reply } = await rpc("tools/list");
    assert.ok(reply.result?.tools?.length, "the server must still answer afterwards");
  });
});

describe("read-only for strangers, open for the operator", () => {
  test("a read tool answers anyone", async () => {
    const { reply } = await rpc("tools/call", { name: "policy", arguments: {} });
    assert.match(textOf(reply), /rules active/i);
  });

  test("execute without the token is refused, and says why", async () => {
    const { reply } = await rpc("tools/call", { name: "execute", arguments: { planId: "anything" } });
    assert.equal(reply.result?.isError, true);
    assert.match(textOf(reply), /read-only/i);
    assert.match(textOf(reply), /Nothing was sent/);
  });

  test("reconcile without the token is refused the same way", async () => {
    const { reply } = await rpc("tools/call", { name: "reconcile", arguments: { planId: "anything" } });
    assert.equal(reply.result?.isError, true);
    assert.match(textOf(reply), /read-only/i);
  });

  test("a wrong token is a stranger", async () => {
    const { reply } = await rpc("tools/call", { name: "execute", arguments: { planId: "x" } }, "operator-secret-for-test");
    assert.equal(reply.result?.isError, true);
    assert.match(textOf(reply), /read-only/i);
  });

  test("the operator's token gets past the read-only gate to the normal checks", async () => {
    // Past the gate, an unknown plan is refused by execute's own logic — which
    // is the proof the gate opened rather than the tool being disabled.
    const { reply } = await rpc("tools/call", { name: "execute", arguments: { planId: "no-such-plan" } }, OPERATOR);
    assert.equal(reply.result?.isError, true);
    assert.doesNotMatch(textOf(reply), /read-only/i);
    assert.match(textOf(reply), /No plan called/);
  });
});
