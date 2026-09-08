#!/usr/bin/env node
/**
 * Enumerate Binance Agent OS's tool surface, and classify each tool.
 *
 * The MCP server runs in a "meta" mode: `tools/list` returns a working subset,
 * and the rest are reached through `tool_search` across its categories and
 * invoked via `tool_execute`. This walks the whole surface from an authorised
 * session, records every tool name and its category, and marks each as a read
 * or a write by its verb.
 *
 * Why it matters: a router that only knows the fifty listed tools is blind to
 * the surface an agent can actually reach. Knowing the full catalogue is what
 * lets the safe default for an unrecognised tool be "treat it as a write and
 * refuse", rather than waving it through as a read.
 *
 * The output is written to docs/agentos-catalogue.json so a reviewer can diff
 * it rather than take it on trust. It is a first-party capture — this session's
 * own OAuth, not a transcription of someone else's list.
 *
 *   node --experimental-strip-types scripts/enumerate-agentos.ts
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentOsClient, findAgentOsToken } from "../src/venues/agentos.ts";

const CATEGORIES = [
  "account", "ai-analysis", "asset", "asset-management", "borrow-repay",
  "capital", "convert", "general", "market", "market-data", "others",
  "portfolio-margin-endpoints", "trade", "transfer", "travel-rule",
];

/** A tool's verb decides whether it can change state. Read-shaped verbs are reads. */
const READ_VERB = /^(get|query|list|check|search|premium|book|depth|klines|candlestick|history|ticker|price|info|exchange|account(?!New)|position|adlRisk|commission|myTrades|report|available|current|estimate|order(Status|Amendment|ListStatus)?$|orderStatus|orderAmendment)/i;
const WRITE_VERB = /(newOrder|placeOrder|placeLimit|cancel|delete|transfer|borrow|repay|swap|withdraw|deposit|set|change|create|close|acceptQuote|sendQuote|redeem|subscribe|enable|disable|update|new)/i;

function classify(name: string): "read" | "write" | "meta" {
  const tail = name.split(".").pop() ?? name;
  if (name === "tool_search" || name === "tool_execute") return "meta";
  // A clear read verb at the start wins: query/get/list name a read even when a
  // write-ish word appears later in the name.
  if (READ_VERB.test(tail)) return "read";
  if (WRITE_VERB.test(tail)) return "write";
  // Neither is clear. The safe classification is write, so an unrecognised tool
  // is never quietly treated as harmless.
  return "write";
}

const token = findAgentOsToken();
if (!token) {
  console.error(
    "No Agent OS session. Connect one and authenticate:\n" +
      "  claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic\n" +
      "then open /mcp and sign in. This script reads the catalogue through that session.",
  );
  process.exit(2);
}

const client = new AgentOsClient(token.token);

const listed = await client.listTools();
const found = new Map<string, { category: string; listed: boolean }>();
for (const t of listed) found.set(t.name, { category: "(tools/list)", listed: true });

let categoriesAnswered = 0;
for (const category of CATEGORIES) {
  try {
    const result = (await client.callTool("tool_search", { category })) as { tools?: { name: string }[]; results?: { name: string }[] } | undefined;
    const names = (result?.tools ?? result?.results ?? []).map((t) => t.name).filter(Boolean);
    if (names.length > 0) categoriesAnswered++;
    for (const name of names) {
      if (!found.has(name)) found.set(name, { category, listed: false });
    }
  } catch {
    // A category that does not answer is normal; skip it.
  }
}

const tools = [...found.entries()]
  .map(([name, meta]) => ({ name, category: meta.category, listed: meta.listed, effect: classify(name) }))
  .sort((a, b) => a.name.localeCompare(b.name));

const byEffect = { read: 0, write: 0, meta: 0 };
for (const t of tools) byEffect[t.effect]++;

const catalogue = {
  provenance: {
    capturedAt: new Date().toISOString(),
    source: "first-party: this repository's own authorised Binance Agent OS session",
    endpoint: "https://agent.binance.com/mcp/agentic",
    method: "tools/list plus tool_search across every category",
    note:
      "The effect classification is by verb and is deliberately fail-closed: a tool whose verb is " +
      "not clearly a read is marked a write, so an unrecognised tool is never treated as harmless.",
  },
  counts: { total: tools.length, listed: listed.length, categoriesAnswered, ...byEffect },
  tools,
};

const out = join(process.cwd(), "docs", "agentos-catalogue.json");
writeFileSync(out, JSON.stringify(catalogue, null, 2) + "\n");
console.log(
  `${tools.length} tools captured (${listed.length} listed, ${categoriesAnswered} categories answered): ` +
    `${byEffect.read} read, ${byEffect.write} write, ${byEffect.meta} meta.`,
);
console.log(`written to ${out}`);
