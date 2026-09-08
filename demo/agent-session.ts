#!/usr/bin/env node
/**
 * The agent's view of Crucible.
 *
 * Everything else in this repository can be driven from a terminal, which makes
 * it easy to mistake for a command-line tool. It is not: it is an MCP server,
 * and the caller it was built for is an AI agent.
 *
 * This drives the real server over the real protocol, issuing exactly the calls
 * an agent makes, and prints what comes back. No output here is composed for the
 * demo — every line is the server's own reply, and the prices are fetched when
 * the script runs.
 *
 *   node --experimental-strip-types demo/agent-session.ts
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "..", "src", "mcp", "server.ts");

const colour = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;
const c = {
  dim: (s: string) => (colour ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (colour ? `\x1b[1m${s}\x1b[0m` : s),
  cyan: (s: string) => (colour ? `\x1b[36m${s}\x1b[0m` : s),
  green: (s: string) => (colour ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (colour ? `\x1b[31m${s}\x1b[0m` : s),
};

interface Reply {
  id?: number;
  result?: { content?: { text?: string }[]; tools?: { name: string; description?: string }[] };
  error?: { message: string };
}

/**
 * A minimal MCP client over stdio.
 *
 * Written here rather than pulled from the SDK on purpose: this file exists to
 * show that the server answers the protocol as specified, and a client sharing
 * the server's own library would prove less about that.
 */
class Client {
  private readonly proc = spawn(process.execPath, ["--experimental-strip-types", SERVER], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  private buffer = "";
  private nextId = 1;
  private readonly waiting = new Map<number, (r: Reply) => void>();

  constructor() {
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let cut: number;
      while ((cut = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, cut).trim();
        this.buffer = this.buffer.slice(cut + 1);
        if (!line.startsWith("{")) continue;
        let reply: Reply;
        try {
          reply = JSON.parse(line) as Reply;
        } catch {
          continue;
        }
        if (reply.id !== undefined) this.waiting.get(reply.id)?.(reply);
      }
    });
  }

  private send(method: string, params?: unknown): Promise<Reply> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 90_000);
      this.waiting.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.proc.stdin.write(
        JSON.stringify(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }

  async open(): Promise<string[]> {
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "demo-agent", version: "1.0" },
    });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const listed = await this.send("tools/list");
    return (listed.result?.tools ?? []).map((t) => t.name);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const reply = await this.send("tools/call", { name, arguments: args });
    if (reply.error) return `error: ${reply.error.message}`;
    return reply.result?.content?.[0]?.text ?? "(no content)";
  }

  close(): void {
    this.proc.kill();
  }
}

/** What a person said, and the tool call the agent chose in response. */
function beat(said: string, tool: string, args: Record<string, unknown>): void {
  console.log();
  console.log(`  ${c.bold("user")}   ${said}`);
  console.log(`  ${c.dim("agent")}  ${c.dim(`calls ${tool}(${JSON.stringify(args)})`)}`);
  console.log();
}

function reply(text: string): void {
  for (const line of text.split("\n")) console.log(`  ${c.cyan("│")} ${line}`);
}

const client = new Client();

const tools = await client.open();
console.log();
console.log(`  ${c.bold("An agent connects to Crucible over MCP.")}`);
console.log(`  ${c.dim(`${tools.length} tools offered: ${tools.join(", ")}`)}`);

beat("What can you actually do right now?", "status", {});
reply(await client.call("status"));

beat("What would it cost me to buy $1,000 of BNB?", "quote", { symbol: "BNBUSDT", usd: 1000 });
reply(await client.call("quote", { symbol: "BNBUSDT", side: "BUY", usd: 1000 }));

beat("And if I bought $100,000 instead?", "quote", { symbol: "BNBUSDT", usd: 100000 });
reply(await client.call("quote", { symbol: "BNBUSDT", side: "BUY", usd: 100000 }));

beat("Go ahead and buy the $1,000 of BNB.", "route", { symbol: "BNBUSDT", usd: 1000 });
reply(await client.call("route", { symbol: "BNBUSDT", side: "BUY", usd: 1000 }));

beat("Actually make it $2,000,000.", "route", { symbol: "BNBUSDT", usd: 2000000 });
reply(await client.call("route", { symbol: "BNBUSDT", side: "BUY", usd: 2000000 }));

beat("Why did you refuse that? What rules are you running?", "policy", {});
reply(await client.call("policy"));

beat("How do I know your cost estimates are any good?", "calibration", {});
reply(await client.call("calibration"));

beat("Show me the evidence behind the venue comparison.", "evidence", {});
reply(await client.call("evidence"));

console.log();
console.log(`  ${c.dim("Every reply above came from the server over MCP, priced when this ran.")}`);
console.log();
client.close();
