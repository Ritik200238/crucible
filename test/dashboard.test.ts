import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createServer } from "../src/dashboard/server.ts";
import { renderPage } from "../src/dashboard/page.ts";
import { ALL_RULES } from "../src/risk/rules.ts";

let server: Server;
let base: string;

before(async () => {
  // Port 0 so a developer already running the dashboard does not fail the suite.
  server = createServer({ port: 0 });
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  // fetch holds its sockets open, and close() alone would wait for them.
  server.closeAllConnections();
  server.close();
  await once(server, "close");
});

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, { headers: { accept: "application/json" } });
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

test("/ serves the page as HTML", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);

  const page = await res.text();
  assert.ok(page.includes("<title>Crucible</title>"), "the page should carry its title");
  assert.equal(page, renderPage(), "the served bytes should be exactly what renderPage produced");
});

test("the page loads nothing from outside this server", async () => {
  const page = await (await fetch(base + "/")).text();

  assert.ok(!page.includes('src="http'), "no element may load a script or image over http");
  assert.ok(!page.includes('href="http'), "no element may link out to a stylesheet or font");
  assert.ok(!page.includes('src="//'), "no protocol-relative script source");
  assert.ok(!page.includes('href="//'), "no protocol-relative stylesheet");
  assert.ok(!page.includes("@import"), "no stylesheet may pull in another");
  assert.ok(!/url\(\s*['"]?http/i.test(page), "no CSS rule may fetch a remote asset");
});

// ---------------------------------------------------------------------------
// Data endpoints
// ---------------------------------------------------------------------------

test("/api/evidence answers with a report shaped like the sampler's summary", async () => {
  const { status, body } = await getJson("/api/evidence");
  assert.equal(status, 200);

  assert.equal(typeof body.total, "number");
  assert.equal(typeof body.failures, "number");
  assert.equal(typeof body.spanHours, "number");
  assert.equal(typeof body.onchainWinRate, "number");
  assert.equal(typeof body.crossoverNote, "string");
  assert.ok(Array.isArray(body.buckets));

  // Rates without a sample count are not evidence, so every bucket carries one.
  for (const bucket of body.buckets) {
    assert.equal(typeof bucket.symbol, "string");
    assert.equal(typeof bucket.notionalUsd, "number");
    assert.ok(Number.isInteger(bucket.count) && bucket.count > 0);
    assert.ok(bucket.onchainWinRate >= 0 && bucket.onchainWinRate <= 1);
    assert.equal(typeof bucket.medianEdgeBps, "number");
  }

  if (body.total > 0) {
    assert.ok(body.buckets.length > 0, "usable samples must land in at least one bucket");
  }
});

test("/api/policy reports every rule and whether it is switched on", async () => {
  const { status, body } = await getJson("/api/policy");
  assert.equal(status, 200);

  assert.ok(body.mode === "dry-run" || body.mode === "live");
  assert.equal(typeof body.live, "boolean");
  assert.equal(typeof body.source, "string");
  assert.ok(body.source.length > 0, "the page has to be able to say where the policy came from");
  assert.equal(typeof body.limits, "object");

  assert.equal(body.rules.length, ALL_RULES.length);
  for (const rule of body.rules) {
    assert.equal(typeof rule.name, "string");
    assert.equal(typeof rule.purpose, "string");
    assert.equal(typeof rule.active, "boolean");
  }
  assert.deepEqual(
    body.rules.map((r: { name: string }) => r.name),
    ALL_RULES.map((r) => r.name),
  );

  // A panel that only ever showed one state would be indistinguishable from one
  // that ignores the policy, so both have to reach it.
  assert.ok(body.rules.some((r: { active: boolean }) => r.active), "some rules are configured");
  assert.ok(
    body.rules.some((r: { active: boolean }) => !r.active),
    "some rules are left unconfigured",
  );
});

test("/api/policy follows the operator's config file rather than the defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crucible-dashboard-"));
  const path = join(dir, "crucible.config.json");
  writeFileSync(path, JSON.stringify({ version: 3, mode: "dry-run", maxOrderNotionalUsd: 42 }));

  const previous = process.env.CRUCIBLE_CONFIG;
  process.env.CRUCIBLE_CONFIG = path;
  try {
    const { body } = await getJson("/api/policy");
    assert.equal(body.version, 3);
    assert.equal(body.source, path);
    assert.deepEqual(body.limits, { maxOrderNotionalUsd: 42 });

    const byName = new Map<string, boolean>(
      body.rules.map((r: { name: string; active: boolean }) => [r.name, r.active]),
    );
    assert.equal(byName.get("max_order_notional"), true);
    assert.equal(byName.get("max_impact_bps"), false);
  } finally {
    if (previous === undefined) delete process.env.CRUCIBLE_CONFIG;
    else process.env.CRUCIBLE_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/api/policy reports a broken config as a server error with the reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crucible-dashboard-"));
  const path = join(dir, "crucible.config.json");
  writeFileSync(path, JSON.stringify({ maxImpactBP: 25 }));

  const previous = process.env.CRUCIBLE_CONFIG;
  process.env.CRUCIBLE_CONFIG = path;
  try {
    const { status, body } = await getJson("/api/policy");
    assert.equal(status, 500);
    assert.match(body.error, /maxImpactBP/);
  } finally {
    if (previous === undefined) delete process.env.CRUCIBLE_CONFIG;
    else process.env.CRUCIBLE_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/api/ledger answers with the verification result and a capped feed", async () => {
  const { status, body } = await getJson("/api/ledger");
  assert.equal(status, 200);

  assert.equal(typeof body.ok, "boolean");
  assert.ok(Number.isInteger(body.records) && body.records >= 0);
  assert.ok(body.brokenAt === null || Number.isInteger(body.brokenAt));
  assert.ok(body.reason === null || typeof body.reason === "string");
  assert.equal(typeof body.signatureValid, "boolean");
  assert.equal(typeof body.path, "string");
  assert.ok(Array.isArray(body.recent));
  assert.ok(body.recent.length <= 50, "the feed is capped at 50 records");
  assert.ok(body.recent.length <= body.records);
  assert.equal(body.ok, body.brokenAt === null && body.signatureValid);

  for (const record of body.recent) {
    assert.ok(Number.isInteger(record.seq));
    assert.equal(typeof record.timestamp, "string");
    assert.equal(typeof record.kind, "string");
    assert.match(record.hash, /^[0-9a-f]{64}$/);
  }
});

// ---------------------------------------------------------------------------
// /api/quote
//
// The live path is deliberately not exercised. It takes a real Binance snapshot
// and a real pool quote, so a test asserting anything about its numbers would
// fail for reasons that have nothing to do with this server, and would move
// money-shaped load onto a public endpoint every time the suite runs. Every
// argument is checked before a request leaves the process, so the cases below
// prove the route exists and answers in JSON without either venue being touched.
// ---------------------------------------------------------------------------

test("/api/quote refuses a request it cannot price, without calling a venue", async () => {
  const missingSize = await getJson("/api/quote?symbol=BNBUSDT");
  assert.equal(missingSize.status, 400);
  assert.match(missingSize.body.error, /usd must be a size in dollars/);

  const badSymbol = await getJson("/api/quote?symbol=&usd=1000");
  assert.equal(badSymbol.status, 400);
  assert.match(badSymbol.body.error, /not a trading pair/);

  const badSide = await getJson("/api/quote?symbol=BNBUSDT&usd=1000&side=HOLD");
  assert.equal(badSide.status, 400);
  assert.match(badSide.body.error, /BUY or SELL/);

  const absurdSize = await getJson("/api/quote?symbol=BNBUSDT&usd=1e12");
  assert.equal(absurdSize.status, 400);
  assert.match(absurdSize.body.error, /ceiling/);
});

// ---------------------------------------------------------------------------
// Everything else
// ---------------------------------------------------------------------------

test("an unknown path answers 404 with a JSON error naming the real routes", async () => {
  const { status, body } = await getJson("/api/receipts");
  assert.equal(status, 404);
  assert.equal(typeof body.error, "string");
  assert.match(body.error, /\/api\/quote/);
  assert.ok(body.error.length > 20, "the message has to tell the reader what does exist");
});

test("a write method answers 405 rather than being quietly ignored", async () => {
  const res = await fetch(base + "/api/policy", { method: "POST" });
  assert.equal(res.status, 405);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.match((await res.json()).error, /only answers GET/);
});
