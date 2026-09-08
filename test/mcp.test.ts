/**
 * The MCP server, which nothing was testing.
 *
 * This is the surface an agent actually talks to, and it was the only entry
 * point with no coverage at all. The suite reached the functions behind it and
 * stopped there, which leaves the part an agent can see — the tool names, what
 * each one accepts, and what comes back when a call goes wrong — resting on
 * nothing but the fact that a demo ran once.
 *
 * The server connects its transport at import, so it is tested the way it is
 * used: as a subprocess speaking JSON-RPC over stdio. That is the real protocol
 * surface rather than a stand-in for it.
 *
 * Only the tools that touch no network are called. A test that quietly needs an
 * exchange to be reachable is a test that fails for reasons unrelated to the
 * code, and the value of this suite is that a green run means the code is good
 * rather than that the network was up.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp", "server.ts");

interface Reply {
  id?: number;
  result?: {
    content?: { type: string; text?: string }[];
    isError?: boolean;
    tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
  };
  error?: { code: number; message: string };
}

/** A JSON-RPC client over stdio, deliberately not sharing the server's SDK. */
class Client {
  private proc!: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly waiting = new Map<number, (r: Reply) => void>();

  start(): void {
    this.proc = spawn(process.execPath, ["--experimental-strip-types", SERVER], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let cut: number;
      while ((cut = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, cut).trim();
        this.buffer = this.buffer.slice(cut + 1);
        if (!line.startsWith("{")) continue;
        try {
          const reply = JSON.parse(line) as Reply;
          if (reply.id !== undefined) this.waiting.get(reply.id)?.(reply);
        } catch {
          // Not a JSON-RPC frame. Ignored on purpose: anything the server
          // writes that is not a frame must not break the client.
        }
      }
    });
  }

  send(method: string, params?: unknown): Promise<Reply> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out after 30s`)), 30_000);
      this.waiting.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      const frame =
        params === undefined
          ? { jsonrpc: "2.0", id, method }
          : { jsonrpc: "2.0", id, method, params };
      this.proc.stdin.write(JSON.stringify(frame) + "\n");
    });
  }

  async handshake(): Promise<void> {
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  call(name: string, args: Record<string, unknown> = {}): Promise<Reply> {
    return this.send("tools/call", { name, arguments: args });
  }

  stop(): void {
    this.proc.kill();
  }
}

const client = new Client();
before(async () => {
  client.start();
  await client.handshake();
});
after(() => client.stop());

const textOf = (r: Reply) => r.result?.content?.[0]?.text ?? "";

describe("what the server offers an agent", () => {
  test("exactly the nine documented tools, no more", () => {
    return client.send("tools/list").then((r) => {
      const names = (r.result?.tools ?? []).map((t) => t.name).sort();
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
  });

  test("every tool describes itself, because the description is how an agent chooses", () => {
    // An agent picks a tool from its description alone. An empty or terse one
    // is not a cosmetic problem: it is the tool being unusable.
    return client.send("tools/list").then((r) => {
      for (const tool of r.result?.tools ?? []) {
        assert.ok(
          (tool.description ?? "").length > 60,
          `${tool.name} has no usable description`,
        );
      }
    });
  });

  test("execute accepts a plan id and nothing else", async () => {
    // The security property the whole design rests on. If execute took order
    // details, an agent could route a small order, be allowed, and then execute
    // a large one — the gates would have checked something that never traded.
    const r = await client.send("tools/list");
    const execute = (r.result?.tools ?? []).find((t) => t.name === "execute");
    assert.ok(execute, "execute must be offered");

    const schema = execute.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    assert.deepEqual(Object.keys(schema.properties ?? {}), ["planId"]);
    assert.deepEqual(schema.required ?? [], ["planId"]);
  });

  test("quote and route accept a size in either denomination", async () => {
    const r = await client.send("tools/list");
    for (const name of ["quote", "route"]) {
      const tool = (r.result?.tools ?? []).find((t) => t.name === name)!;
      const props = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      assert.ok(props.includes("symbol"), `${name} must take a symbol`);
      assert.ok(props.includes("side"), `${name} must take a side`);
      assert.ok(props.includes("usd"), `${name} must accept a size in dollars`);
      assert.ok(props.includes("baseQty"), `${name} must accept a size in base units`);
    }
  });
});

describe("the tools that read local state", () => {
  test("policy reports the rules and says it is not the agent's to change", async () => {
    const body = textOf(await client.call("policy"));
    assert.match(body, /rules active/i);
    // An agent that believes it can raise its own limit will try. The tool has
    // to say plainly that it cannot.
    assert.match(body, /you cannot change it/i);
  });

  test("policy states the execution mode, so an agent never assumes it is live", async () => {
    const body = textOf(await client.call("policy"));
    assert.match(body, /mode: (dry-run|live)/);
  });

  test("calibration reports having no data rather than reporting accuracy", async () => {
    // The report a judge or an agent is most likely to quote back as proof the
    // product works. With no executions it has to refuse to sound confident.
    const body = textOf(await client.call("calibration"));
    assert.match(body, /never been checked|not been graded|execution/i);
  });

  test("verify_ledger answers even when no ledger has been written", async () => {
    const reply = await client.call("verify_ledger");
    assert.ok(textOf(reply).length > 0, "verification must always say something");
  });

  test("evidence returns the recorded comparison", async () => {
    const body = textOf(await client.call("evidence"));
    assert.ok(body.length > 0);
  });
});

describe("what happens when a call is wrong", () => {
  test("an unknown tool is refused rather than ignored", async () => {
    const reply = await client.call("drain_wallet");
    const failed = reply.error !== undefined || reply.result?.isError === true;
    assert.ok(failed, "an unknown tool must not come back as a success");
  });

  test("a missing required argument is refused before anything is priced", async () => {
    // This must fail on validation, not by reaching an exchange and failing
    // there. A schema that lets a malformed call through is a schema that
    // sends a malformed order.
    const reply = await client.call("quote", { side: "BUY", usd: 1000 });
    const failed = reply.error !== undefined || reply.result?.isError === true;
    assert.ok(failed, "quote without a symbol must be refused");
  });

  test("an argument of the wrong type is refused", async () => {
    const reply = await client.call("execute", { planId: 12345 });
    const failed = reply.error !== undefined || reply.result?.isError === true;
    assert.ok(failed, "a numeric plan id must be refused");
  });

  test("an unknown plan id is refused rather than executing something else", async () => {
    const reply = await client.call("execute", { planId: "no-such-plan" });
    const failed = reply.error !== undefined || reply.result?.isError === true || /not|unknown|expired/i.test(textOf(reply));
    assert.ok(failed, "an unknown plan must never resolve to a real one");
  });

  test("a failed call does not take the server down", async () => {
    // A crash here strands the agent mid-conversation with no way to recover.
    await client.call("drain_wallet");
    await client.call("quote", {});
    const body = textOf(await client.call("policy"));
    assert.match(body, /rules active/i, "the server must still answer after bad calls");
  });
});
