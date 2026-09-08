#!/usr/bin/env node
/**
 * The dashboard server.
 *
 * `node:http` and nothing else. Adding a framework here would mean a dependency
 * tree in front of the one thing that has to stay obviously trustworthy: the
 * page that shows what the router decided and whether the ledger still holds.
 *
 * Every endpoint reads the same code the CLI and the MCP server read. There is
 * no separate data path for the screen, so the page cannot show a number the
 * product does not actually produce.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { SnapshotError, takeSnapshot } from "../snapshot.ts";
import { resolveCommission } from "../venues/commission.ts";
import { priceAllRoutes } from "../cost/model.ts";
import { ConfigError, isLiveEnabled, loadPolicy } from "../config.ts";
import { ALL_RULES } from "../risk/rules.ts";
import { isSample, readSamples } from "../sampler/run.ts";
import { summarise, type EvidenceReport } from "../sampler/analyse.ts";
import { Ledger, ledgerPaths, type LedgerRecord } from "../ledger/chain.ts";
import { verifyLedger } from "../ledger/verify.ts";
import { BinanceError } from "../venues/binance.ts";
import { OnchainError } from "../venues/onchain.ts";
import { renderPage } from "./page.ts";
import { handleMcpRequest } from "../mcp/http.ts";
import type { CostComponent, Side } from "../types.ts";

export const DEFAULT_PORT = 8787;

/**
 * Who may execute through the HTTP MCP endpoint.
 *
 * `CRUCIBLE_MCP_TOKEN` set: the instance is treated as public, and execute and
 * reconcile need that token as a bearer. Unset: local, every tool open. A
 * hosted instance without a token would let anyone who found the URL send an
 * order, so `startDashboard` refuses to bind beyond loopback without one.
 */
function mcpOptions(): { operatorToken?: string } {
  const token = process.env.CRUCIBLE_MCP_TOKEN?.trim();
  return token ? { operatorToken: token } : {};
}

/**
 * A path fit to publish.
 *
 * The CLI prints absolute paths on purpose — an operator on their own machine
 * wants to know exactly which file was read. This page is served to strangers,
 * where the same string hands out a username and a directory layout for
 * nothing. Relative to the working directory says as much as anyone browsing
 * needs, and a path outside it degrades to its filename rather than climbing
 * back out in dots.
 */
function publicPath(full: string): string {
  const rel = relative(process.cwd(), full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return basename(full);
  return rel.split(sep).join("/");
}

/** How many records the ledger panel shows. */
const RECENT_RECORDS = 50;

/**
 * The page never changes between requests — every figure on it arrives by
 * fetch — so it is built once at startup and served from memory.
 */
const PAGE = Buffer.from(renderPage(), "utf8");

/** A request the caller can fix by asking differently. Answered with 400. */
class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequest";
  }
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

function evidencePayload(): EvidenceReport {
  const rows = readSamples();
  const samples = rows.filter(isSample);
  // Failed sweeps are counted rather than dropped. A pass where the pool was
  // unreachable is a real fact about the comparison, and leaving it out would
  // flatter whichever venue happened to be answering.
  return summarise(samples, rows.length - samples.length);
}

interface PolicyPayload {
  mode: string;
  live: boolean;
  version: number;
  source: string;
  rules: { name: string; purpose: string; active: boolean }[];
  limits: Record<string, unknown>;
}

function policyPayload(): PolicyPayload {
  const { policy, source } = loadPolicy(process.env.CRUCIBLE_CONFIG);
  // `version` and `mode` are reported on their own; what is left is exactly the
  // set of limits, so a rule shown as active always has its number beside it.
  const { version, mode, ...limits } = policy;
  return {
    mode,
    live: isLiveEnabled(policy),
    version,
    source: source.startsWith("built-in") ? source : publicPath(source),
    rules: ALL_RULES.map((rule) => ({
      name: rule.name,
      purpose: rule.purpose,
      active: rule.isConfigured(policy),
    })),
    limits,
  };
}

interface LedgerPayload {
  ok: boolean;
  records: number;
  brokenAt: number | null;
  reason: string | null;
  signatureValid: boolean;
  path: string;
  /** Newest first, capped at RECENT_RECORDS. */
  recent: LedgerRecord[];
  /** Why the feed is empty when verification still had something to say. */
  recentUnavailable: string | null;
}

function ledgerPayload(): LedgerPayload {
  const verification = verifyLedger();
  const paths = ledgerPaths();

  let recent: LedgerRecord[] = [];
  let recentUnavailable: string | null = null;
  try {
    recent = new Ledger().read().slice(-RECENT_RECORDS).reverse();
  } catch (err) {
    // A hole in the file makes the records unreadable but not the verdict:
    // verification already names the index it breaks at, so the feed reports
    // why it is empty instead of the panel going blank.
    recentUnavailable = (err as Error).message;
  }

  return { ...verification, path: publicPath(paths.ledger), recent, recentUnavailable };
}

interface QuoteRoute {
  venue: string;
  style: string;
  unavailable?: string;
  totalBps?: number;
  totalUsd?: number;
  effectivePrice?: number;
  hasEstimates?: boolean;
  components: CostComponent[];
}

interface QuotePayload {
  symbol: string;
  side: Side;
  requestedUsd: number;
  notionalUsd: number;
  baseQty: number;
  baseAsset: string;
  quoteAsset: string;
  quoteAssetPrecision: number;
  mid: number;
  spreadBps: number;
  flowPerSec: number;
  flowWindowSec: number;
  commission: { maker: number; taker: number; source: string };
  snapshotHash: string;
  takenAt: number;
  onchainUnavailable: string | null;
  routes: QuoteRoute[];
  cheapest: string | null;
  edgeBps: number | null;
}

async function priceQuote(symbol: string, side: Side, usd: number): Promise<QuotePayload> {
  // A Binance-only probe turns dollars into a base quantity first. The pool has
  // to be quoted at the real size or its impact figure means nothing, and the
  // size is not known until a price is.
  const probe = await takeSnapshot({ symbol, side, baseQty: 1, skipOnchain: true });
  const baseQty = usd / probe.mid;

  const snapshot = await takeSnapshot({ symbol, side, baseQty, commission: await resolveCommission(symbol) });
  const priced = priceAllRoutes({ snapshot, side, baseQty });

  const routes: QuoteRoute[] = priced.map((r) =>
    // An unavailable route costs Infinity, which JSON has no form for and would
    // silently become null. It carries no numbers at all instead, so the page
    // has nothing it could accidentally print as a price.
    r.unavailable
      ? { venue: r.venue, style: r.style, unavailable: r.unavailable, components: [] }
      : {
          venue: r.venue,
          style: r.style,
          totalBps: r.totalBps,
          totalUsd: r.totalUsd,
          effectivePrice: r.effectivePrice,
          hasEstimates: r.hasEstimates,
          components: r.components,
        },
  );

  const usable = priced.filter((r) => !r.unavailable).sort((a, b) => a.totalBps - b.totalBps);
  const best = usable[0];
  const runnerUp = usable[1];

  return {
    symbol: snapshot.symbol,
    side,
    requestedUsd: usd,
    notionalUsd: baseQty * snapshot.mid,
    baseQty,
    baseAsset: snapshot.filters.baseAsset,
    quoteAsset: snapshot.filters.quoteAsset,
    quoteAssetPrecision: snapshot.filters.quoteAssetPrecision,
    mid: snapshot.mid,
    spreadBps: snapshot.spreadBps,
    flowPerSec: side === "BUY" ? snapshot.flow.hitsBidPerSec : snapshot.flow.liftsAskPerSec,
    flowWindowSec: snapshot.flow.windowSec,
    commission: snapshot.commission,
    snapshotHash: snapshot.hash,
    takenAt: snapshot.takenAt,
    onchainUnavailable: snapshot.onchainUnavailable ?? null,
    routes,
    cheapest: best ? `${best.venue}/${best.style}` : null,
    edgeBps: best && runnerUp ? runnerUp.totalBps - best.totalBps : null,
  };
}

/**
 * Quotes are held for five seconds, keyed by symbol, size and side.
 *
 * One quote is four Binance requests plus a call to every pool fee tier. A page
 * left open on a second monitor, or refreshed a few times while someone reads
 * it, would otherwise spend the request weight the sampler needs to keep
 * running for days. Five seconds is also about as long as one of these quotes
 * is worth anything at the margins being compared, so nothing staler is served.
 *
 * The promise is cached rather than its result, so two browsers asking at the
 * same instant share one snapshot instead of racing to take two.
 */
const QUOTE_TTL_MS = 5_000;

interface CachedQuote {
  startedAt: number;
  result: Promise<QuotePayload>;
}

const quoteCache = new Map<string, CachedQuote>();

function cachedQuote(symbol: string, side: Side, usd: number): Promise<QuotePayload> {
  const now = Date.now();
  for (const [key, held] of quoteCache) {
    if (now - held.startedAt >= QUOTE_TTL_MS) quoteCache.delete(key);
  }

  const key = `${symbol}|${side}|${usd}`;
  const held = quoteCache.get(key);
  if (held) return held.result;

  const entry: CachedQuote = { startedAt: now, result: priceQuote(symbol, side, usd) };
  // A failure is not worth keeping. Holding it would turn one dropped RPC call
  // into five seconds of the same error for everyone who reloads.
  entry.result.catch(() => {
    if (quoteCache.get(key) === entry) quoteCache.delete(key);
  });
  quoteCache.set(key, entry);
  return entry.result;
}

const SYMBOL = /^[A-Z0-9]{4,20}$/;

/** Largest size that can be asked for, above which no book here is meaningful. */
const MAX_QUOTE_USD = 1_000_000_000;

function quoteFromQuery(params: URLSearchParams): Promise<QuotePayload> {
  const rawSymbol = params.get("symbol") ?? "";
  const symbol = rawSymbol.trim().toUpperCase();
  if (!SYMBOL.test(symbol)) {
    throw new BadRequest(
      `"${rawSymbol}" is not a trading pair. Pass symbol=BNBUSDT, or any other pair Binance lists.`,
    );
  }

  const rawSide = (params.get("side") ?? "BUY").trim().toUpperCase();
  if (rawSide !== "BUY" && rawSide !== "SELL") {
    throw new BadRequest(`side must be BUY or SELL. It was "${params.get("side")}".`);
  }

  const rawUsd = params.get("usd");
  const usd = Number(rawUsd);
  if (rawUsd === null || rawUsd.trim() === "" || !Number.isFinite(usd) || usd <= 0) {
    throw new BadRequest(`usd must be a size in dollars greater than zero. It was "${rawUsd}".`);
  }
  if (usd > MAX_QUOTE_USD) {
    throw new BadRequest(
      `usd was ${usd}, which is past the ${MAX_QUOTE_USD.toLocaleString("en-US")} ceiling this ` +
        `endpoint will price. No book or pool reached from here can fill that, so the answer ` +
        `would be a number with nothing behind it.`,
    );
  }

  return cachedQuote(symbol, rawSide, usd);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function sendPage(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": PAGE.byteLength,
    "cache-control": "no-store",
    // The page claims to make no external request. This is that claim enforced
    // by the browser rather than asserted in a comment: nothing may be loaded
    // from anywhere, and the only connections allowed are back to this server.
    "content-security-policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
      "connect-src 'self'; base-uri 'none'; form-action 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(PAGE);
}

function statusFor(err: unknown): number {
  if (err instanceof BadRequest) return 400;
  // A venue that cannot be reached is not this server's fault, and calling it a
  // 500 would send whoever is on call looking in the wrong place.
  if (err instanceof BinanceError || err instanceof OnchainError || err instanceof SnapshotError) {
    return 502;
  }
  return 500;
}

function messageFor(err: unknown): string {
  if (err instanceof ConfigError) {
    return `The policy file could not be loaded, so no limit on this page can be trusted: ${err.message}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message === "" ? "The request failed without reporting a reason." : message;
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Only the path and query are used; the authority is a placeholder that
  // exists because URL needs a base for a relative request target.
  const url = new URL(req.url ?? "/", "http://dashboard.invalid");
  const path = url.pathname;

  // The MCP endpoint takes POST and manages its own replies. It sits before the
  // read-only guard because it is the one route here that may change state —
  // and only for a caller holding the operator's token when the instance is
  // public.
  if (path === "/mcp") {
    await handleMcpRequest(req, res, mcpOptions());
    return;
  }

  // HEAD is answered wherever GET is, which HTTP requires. Node discards the
  // body of a HEAD response on its own, so the handlers below need no special
  // case: they build the reply as usual and only the headers reach the client.
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, {
      error: `${req.method ?? "That method"} is not allowed. The dashboard only answers GET; ` +
        `nothing here changes state.`,
    });
    return;
  }

  try {
    switch (path) {
      case "/":
        sendPage(res);
        return;
      case "/api/evidence":
        sendJson(res, 200, evidencePayload());
        return;
      case "/api/policy":
        sendJson(res, 200, policyPayload());
        return;
      case "/api/ledger":
        sendJson(res, 200, ledgerPayload());
        return;
      case "/api/quote":
        sendJson(res, 200, await quoteFromQuery(url.searchParams));
        return;
      default:
        sendJson(res, 404, {
          error:
            `Nothing is served at ${path}. This server answers / for the page, ` +
            `/api/quote, /api/evidence, /api/policy and /api/ledger for its data, and POST /mcp for agents.`,
        });
        return;
    }
  } catch (err) {
    const status = statusFor(err);
    if (status >= 500) console.error(`[dashboard] ${req.method} ${path} failed`, err);
    sendJson(res, status, { error: messageFor(err) });
  }
}

export interface DashboardOptions {
  /** Interface to bind. Defaults to loopback, or every interface when CRUCIBLE_MCP_TOKEN is set. */
  host?: string;
  /** Start listening on this port straight away. Omit to call listen yourself. */
  port?: number;
}

export function createServer(opts: DashboardOptions = {}): Server {
  const server = createHttpServer((req, res) => {
    handle(req, res).catch((err) => {
      // handle() answers its own failures, so arriving here means the response
      // itself broke. There is nothing left that can be sent.
      console.error("[dashboard] the response could not be written", err);
      res.destroy();
    });
  });
  // Loopback unless the instance has been given an operator token, which is
  // the signal that it is meant to be public. Binding every interface without
  // one would hand the execute tool to whoever found the port.
  if (opts.port !== undefined) server.listen(opts.port, opts.host ?? defaultHost());
  return server;
}

function defaultHost(): string {
  return process.env.CRUCIBLE_MCP_TOKEN?.trim() ? "0.0.0.0" : "127.0.0.1";
}

export async function startDashboard(port: number = DEFAULT_PORT, host?: string): Promise<Server> {
  const server = createServer(host === undefined ? { port } : { port, host });
  // `once` rejects if the socket emits an error, so a port already in use
  // fails here with the real reason rather than hanging on a listen that
  // never happens.
  await once(server, "listening");
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;
  const where = host ?? defaultHost();
  console.log(
    `Crucible dashboard is up on ${where}:${bound}. Open localhost:${bound} in a browser; agents connect to POST /mcp` +
      (process.env.CRUCIBLE_MCP_TOKEN?.trim() ? " (public: execute and reconcile need the operator token)." : "."),
  );
  return server;
}

/**
 * Which port to listen on.
 *
 * `CRUCIBLE_DASHBOARD_PORT` first, because an operator who names a port means
 * it. Then `PORT`, which is how every container host — Railway, Render, Fly,
 * Heroku — tells a process where to listen; ignoring it means the platform
 * routes to a port nothing is on and the deploy fails its health check with no
 * useful error. Then the default, for a local run.
 */
export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const named = env.CRUCIBLE_DASHBOARD_PORT ?? env.PORT;
  if (named === undefined || named.trim() === "") return DEFAULT_PORT;
  const port = Number(named);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ConfigError(
      `${env.CRUCIBLE_DASHBOARD_PORT !== undefined ? "CRUCIBLE_DASHBOARD_PORT" : "PORT"} is ` +
        `"${named}", which is not a port. Set it to a whole number from 0 to 65535, or unset it ` +
        `to use ${DEFAULT_PORT}.`,
    );
  }
  return port;
}

/**
 * Refuse to start unguarded on a platform that will publish us.
 *
 * `PORT` is set by container hosts and by nothing else, so its presence is the
 * signal that this process is about to be reachable from the internet. Without
 * an operator token the server binds loopback — which inside a container means
 * the platform's health check reaches nothing, and the deploy fails with a
 * timeout that says nothing about the cause.
 *
 * Failing here instead names the cause, and closes the worse door: a hosted
 * instance that did bind publicly with `execute` and `reconcile` ungated.
 */
export function assertHostable(env: NodeJS.ProcessEnv = process.env): void {
  if (env.PORT === undefined || env.CRUCIBLE_MCP_TOKEN?.trim()) return;
  throw new ConfigError(
    "PORT is set, so this looks like a hosted deploy, but CRUCIBLE_MCP_TOKEN is not. Refusing to " +
      "start.\n\n" +
      "That variable does two things: it makes the instance public read-only — every read tool " +
      "answers anyone, and execute and reconcile need the token as a bearer — and it lets the " +
      "server bind every interface instead of loopback. Without it a container binds to itself, " +
      "the platform's health check reaches nothing, and the deploy fails for a reason nobody can " +
      "see.\n\n" +
      "Set CRUCIBLE_MCP_TOKEN to a long random secret in the platform's variables, and keep it. " +
      "Anyone holding it can execute orders through this instance.",
  );
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  let port: number;
  try {
    assertHostable();
    port = resolvePort();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  await startDashboard(port);
}
