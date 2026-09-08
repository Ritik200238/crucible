/**
 * The on-chain leg, through the Binance Agentic Wallet CLI.
 *
 * This process never holds, reads or signs with a private key. It shells out to
 * `baw`, which talks to a wallet the operator authorised from the Binance app
 * and which enforces its own daily limit and token scope at the API level. The
 * worst this code can do is ask; the wallet decides.
 *
 * The one rule that matters here, and it comes from Binance's own
 * documentation: a successful swap call returns an `orderId`, and an `orderId`
 * is not a completed swap. The order can still end `FAILED` on-chain with no
 * transaction hash. Nothing in this module reports success until the order has
 * reached a terminal state on a second, separate read.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WalletQuote } from "../types.ts";

export class WalletError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = "WalletError";
    this.code = code;
  }
}

/** BNB Smart Chain, as the wallet CLI names it. */
export const BSC = "56";

const DEFAULT_TIMEOUT_MS = 120_000;

interface CliResult<T> {
  success: boolean;
  data?: T;
  error?: { code?: number; name?: string; message?: string };
}

export interface WalletOptions {
  /** Overridable so a pinned install can be used instead of whatever is on PATH. */
  bin?: string;
  timeoutMs?: number;
}

/**
 * How to invoke the CLI: a command plus any leading arguments.
 *
 * On Windows an npm global binary is a `.cmd` shim, and `execFile` cannot spawn
 * one without a shell. Running it through a shell would mean every token
 * carrying a contract address or an amount is parsed as shell syntax, which is
 * not a trade worth making for a process that moves money. So the package's own
 * entry point is located and run with this same Node binary instead — no shim,
 * no shell, identical behaviour on every platform.
 */
let resolved: { command: string; prefix: string[] } | null = null;

function npmGlobalRoot(): string | null {
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    // This one call is allowed a shell on Windows because its arguments are
    // fixed literals with nothing interpolated into them.
    return execFileSync(npm, ["root", "-g"], {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
      shell: process.platform === "win32",
    }).trim();
  } catch {
    return null;
  }
}

export function resolveCli(bin?: string): { command: string; prefix: string[] } {
  const explicit = bin ?? process.env.BAW_BIN;
  if (explicit) return { command: explicit, prefix: [] };
  if (resolved) return resolved;

  const root = npmGlobalRoot();
  if (root) {
    const entry = join(root, "@binance", "agentic-wallet", "dist", "index.js");
    if (existsSync(entry)) {
      resolved = { command: process.execPath, prefix: [entry] };
      return resolved;
    }
  }
  // Nothing located: fall back to the name on PATH, which works wherever the
  // binary is a real executable rather than a shim.
  resolved = { command: "baw", prefix: [] };
  return resolved;
}

/**
 * Run one `baw` command.
 *
 * `--json` is appended by the caller rather than here, so a command that does
 * not support it fails visibly instead of being silently mangled. Arguments go
 * through `execFile` as an array: no shell, so an address or amount cannot be
 * read as shell syntax.
 */
async function run<T>(args: string[], opts: WalletOptions = {}): Promise<T> {
  const cli = resolveCli(opts.bin);
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const { stdout, stderr, failed } = await new Promise<{
    stdout: string;
    stderr: string;
    failed: Error | null;
  }>((resolve) => {
    execFile(
      cli.command,
      [...cli.prefix, ...args],
      { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, out, errOut) => resolve({ stdout: out, stderr: errOut, failed: err }),
    );
  });

  if (failed && !stdout.trim()) {
    const hint =
      (failed as NodeJS.ErrnoException).code === "ENOENT"
        ? `The wallet CLI was not found. Install it with: npm i -g @binance/agentic-wallet`
        : stderr.trim() || failed.message;
    throw new WalletError(`baw ${args[0]} ${args[1] ?? ""} failed: ${hint}`);
  }

  let parsed: CliResult<T>;
  try {
    parsed = JSON.parse(stdout) as CliResult<T>;
  } catch {
    throw new WalletError(
      `The wallet CLI returned output that is not JSON. Command: baw ${args.join(" ")}. ` +
        `Output began: ${stdout.slice(0, 200)}`,
    );
  }

  if (!parsed.success) {
    const e = parsed.error;
    throw new WalletError(
      `The wallet refused: ${e?.message ?? "no reason given"}`,
      e?.name ?? (e?.code !== undefined ? String(e.code) : null),
    );
  }
  if (parsed.data === undefined) {
    throw new WalletError(`baw ${args.join(" ")} reported success but returned no data.`);
  }
  return parsed.data;
}

export interface WalletStatus {
  connected: boolean;
  raw: Record<string, unknown>;
}

/**
 * Whether a wallet session exists.
 *
 * The CLI is the source of truth here, not what the phone app shows. The two
 * can disagree — an interrupted sign-in leaves the app looking connected while
 * the CLI is not — and acting on the app's view would mean building a plan
 * around a leg that cannot execute.
 */
export async function walletStatus(opts: WalletOptions = {}): Promise<WalletStatus> {
  const data = await run<Record<string, unknown>>(["wallet", "status", "--json"], opts);
  const status = String(data.status ?? data.state ?? "").toUpperCase();
  return {
    connected: status !== "" && status !== "UNCONNECTED" && status !== "DISCONNECTED",
    raw: data,
  };
}

export interface WalletLimits {
  dailyLimitUsd: number;
  quotaUsedUsd: number;
  quotaLeftUsd: number;
  /** How the wallet handles a transaction it considers abnormal. */
  abnormalHandling: string;
  tradeAllTokens: boolean;
}

/** The wallet's own limits. Read-only here; they are set in the Binance app. */
export async function walletLimits(opts: WalletOptions = {}): Promise<WalletLimits> {
  const d = await run<Record<string, unknown>>(["wallet", "settings", "--json"], opts);
  return {
    dailyLimitUsd: Number(d.dailyLimit ?? 0),
    quotaUsedUsd: Number(d.quotaUsed ?? 0),
    quotaLeftUsd: Number(d.quotaLeft ?? 0),
    abnormalHandling: String(d.abnormalTxnHandling ?? "unknown"),
    tradeAllTokens: d.tradeAllTokens === true,
  };
}

export interface SwapParams {
  fromToken: string;
  toToken: string;
  /** Amount of the input token, in human-readable units. */
  fromTokenQty: number;
  chainId?: string;
  /** "auto", or a percentage such as 0.5. */
  slippage?: string;
  mevProtection?: boolean;
}

function swapArgs(p: SwapParams): string[] {
  const args = [
    "--fromTokenQty",
    String(p.fromTokenQty),
    "--fromToken",
    p.fromToken,
    "--toToken",
    p.toToken,
    "--binanceChainId",
    p.chainId ?? BSC,
  ];
  if (p.slippage !== undefined) args.push("--slippage", p.slippage);
  if (p.mevProtection !== undefined) args.push("--mev", String(p.mevProtection));
  return args;
}

/** What the wallet says the swap would pay out. No transaction is created. */
export async function quoteSwap(p: SwapParams, opts: WalletOptions = {}): Promise<WalletQuote> {
  const d = await run<Record<string, unknown>>(
    ["market-order", "quote", ...swapArgs(p), "--json"],
    opts,
  );
  const amountOut = Number(d.toCoinAmount);
  if (!Number.isFinite(amountOut) || amountOut <= 0) {
    throw new WalletError(`The wallet returned an unusable quote: ${JSON.stringify(d).slice(0, 200)}`);
  }
  return {
    fromSymbol: String(d.fromCoinSymbol ?? ""),
    toSymbol: String(d.toCoinSymbol ?? ""),
    amountIn: Number(d.fromCoinAmount ?? p.fromTokenQty),
    amountOut,
    slippage: Number(d.slippage ?? 0),
  };
}

export type SwapStatus = "PENDING" | "FINISHED" | "FAILED";

export interface SwapOrder {
  orderId: string;
  status: SwapStatus;
  txHash: string | null;
  fromTokenQty: number;
  toTokenQty: number;
  fromTokenName: string;
  toTokenName: string;
}

/** Look one swap order up by id. This is the read that decides the outcome. */
export async function getSwapOrder(orderId: string, opts: WalletOptions = {}): Promise<SwapOrder> {
  const d = await run<{ list?: Record<string, unknown>[] }>(
    ["market-order", "list", "--orderId", orderId, "--json"],
    opts,
  );
  const row = d.list?.[0];
  if (!row) throw new WalletError(`The wallet has no record of swap order ${orderId}.`);

  const status = String(row.status ?? "PENDING").toUpperCase() as SwapStatus;
  const hash = row.txHash;
  return {
    orderId: String(row.orderId ?? orderId),
    status,
    txHash: typeof hash === "string" && hash.length > 0 ? hash : null,
    fromTokenQty: Number(row.fromTokenQty ?? 0),
    toTokenQty: Number(row.toTokenQty ?? 0),
    fromTokenName: String(row.fromTokenName ?? ""),
    toTokenName: String(row.toTokenName ?? ""),
  };
}

/**
 * Submit a swap and wait for it to settle.
 *
 * Returns the terminal order, whether that is `FINISHED` or `FAILED`. A failure
 * is a normal outcome of a live swap — slippage, thin liquidity, a routing
 * problem — so it is returned rather than thrown, and the caller reports it as
 * what it is. Running out of patience is different from failing, and that does
 * throw, because "still pending" is not an outcome anyone can act on.
 */
export async function executeSwap(
  p: SwapParams,
  opts: WalletOptions & { pollMs?: number; timeoutMs?: number } = {},
): Promise<SwapOrder> {
  const submitted = await run<{ orderId: string }>(
    ["market-order", "swap", ...swapArgs(p), "--json"],
    opts,
  );
  const orderId = String(submitted.orderId);
  if (!orderId) throw new WalletError("The wallet accepted the swap but returned no order id.");

  const pollMs = opts.pollMs ?? 2000;
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);

  for (;;) {
    const order = await getSwapOrder(orderId, opts);
    if (order.status === "FINISHED" || order.status === "FAILED") return order;
    if (Date.now() > deadline) {
      throw new WalletError(
        `Swap ${orderId} is still PENDING after ${Math.round((opts.timeoutMs ?? 90_000) / 1000)}s. ` +
          `It has not failed and it has not settled. Check it with: baw market-order list --orderId ${orderId} --json`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Whether the CLI is installed at all, and which version. */
export async function walletVersion(opts: WalletOptions = {}): Promise<string | null> {
  const cli = resolveCli(opts.bin);
  return new Promise((resolve) => {
    execFile(
      cli.command,
      [...cli.prefix, "--version"],
      { timeout: 20_000, windowsHide: true },
      (err, out) => resolve(err ? null : out.trim()),
    );
  });
}
