/**
 * Binance Agent OS: the exchange's own MCP server, used as a data source.
 *
 * Commission is the largest single component of every exchange-side cost this
 * product reports — ten of the eleven basis points on a typical taker quote —
 * and without a credential it falls back to the public VIP 0 schedule and says
 * so. Agent OS offers a way to read the account's real rate without an API key
 * on this machine: the user authorises the exchange's MCP server once from
 * their own client, and that session can answer `account/commission`.
 *
 * This is a client for that server, deliberately narrow. It reads. It does not
 * place orders through the MCP, because the execution path already signs its
 * own requests and a second order path would be a second thing to get wrong.
 *
 * Facts about the server that this code depends on, and where they came from:
 *
 *   - Endpoint, transport and the client setup flow are documented at
 *     developers.binance.com/en/docs/agent-native/mcp-server/agentic.
 *   - The response shape of the commission call is the documented REST shape
 *     of `GET /api/v3/account/commission` (`standardCommission.maker/taker`,
 *     `discount`), which the MCP tool wraps.
 *   - The server runs in a "meta" mode: `tools/list` returns a subset, and the
 *     rest are reached by `tool_search` and invoked through `tool_execute` with
 *     `{ toolName, arguments }`. The `Accept` header must list both JSON and
 *     event-stream. These are NOT VERIFIED from this machine: the endpoint
 *     answers 401 until a user has authorised it, and no session has been
 *     established here. The code is written so that if any of them is wrong
 *     the result is a labelled fallback to the public schedule, never a wrong
 *     number presented as the account's.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const BINANCE_MCP_URL = "https://agent.binance.com/mcp/agentic";
const MCP_PROTOCOL_VERSION = "2025-06-18";

export class AgentOsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentOsError";
  }
}

export interface AgentOsToken {
  token: string;
  /** Where it came from, for the status screen. Never the token itself. */
  source: "env" | "claude-code";
}

/**
 * Find a session token for the Binance MCP server.
 *
 * Two places, in order. `BINANCE_MCP_TOKEN` is how a server or CI supplies it.
 * Otherwise the token the user's own Claude Code session established with
 * `claude mcp add binance-mcp-server ...` and the `/mcp` authorisation flow,
 * which Claude Code keeps in its credential store keyed by server URL. Reading
 * it means this product needs no credential of its own: the user granted the
 * scope once, on the exchange's consent screen, to a client they chose.
 *
 * Returns null when there is none. That is the normal state and not an error.
 */
export function findAgentOsToken(
  env: NodeJS.ProcessEnv = process.env,
  credentialsPath = join(homedir(), ".claude", ".credentials.json"),
): AgentOsToken | null {
  const fromEnv = env.BINANCE_MCP_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "env" };

  let raw: string;
  try {
    raw = readFileSync(credentialsPath, "utf8");
  } catch {
    return null;
  }

  let parsed: { mcpOAuth?: Record<string, { serverUrl?: string; accessToken?: string }> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  for (const entry of Object.values(parsed.mcpOAuth ?? {})) {
    if (!entry || typeof entry !== "object") continue;
    const url = (entry.serverUrl ?? "").replace(/\/+$/, "");
    if (url === BINANCE_MCP_URL && typeof entry.accessToken === "string" && entry.accessToken) {
      return { token: entry.accessToken, source: "claude-code" };
    }
  }
  return null;
}

interface JsonRpcReply {
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolDescriptor {
  name: string;
  description?: string;
}

interface ToolCallResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * A minimal JSON-RPC client over streamable HTTP.
 *
 * The server may answer a POST with a JSON body or with an event stream carrying
 * one `data:` frame per message. Both are handled, because which one arrives is
 * the server's choice and a client that only reads one is a client that works
 * until the server is upgraded.
 */
export class AgentOsClient {
  private nextId = 1;
  private readonly fetchImpl: typeof fetch;
  private tools: ToolDescriptor[] | null = null;
  private readonly token: string;
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(
    token: string,
    opts: { url?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  ) {
    this.token = token;
    this.url = opts.url ?? BINANCE_MCP_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private async rpc(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${this.token}`,
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
        body: JSON.stringify(
          params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params },
        ),
      });
    } catch (err) {
      throw new AgentOsError(
        (err as Error).name === "AbortError"
          ? `Binance's MCP server did not answer ${method} within ${this.timeoutMs} ms.`
          : `Could not reach Binance's MCP server for ${method}: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      throw new AgentOsError(
        `Binance's MCP server refused the session (HTTP ${res.status}). The authorisation has expired or ` +
          `was revoked. Reconnect it from your MCP client: in Claude Code, open /mcp, select ` +
          `binance-mcp-server and authenticate again.`,
      );
    }
    if (!res.ok) {
      throw new AgentOsError(`Binance's MCP server answered ${method} with HTTP ${res.status}.`);
    }

    const body = await res.text();
    const reply = parseReply(body, res.headers.get("content-type") ?? "", id);
    if (reply.error) {
      throw new AgentOsError(`Binance's MCP server rejected ${method}: ${reply.error.message} (${reply.error.code})`);
    }
    return reply.result;
  }

  /** Every tool the server lists directly. Cached for the client's lifetime. */
  async listTools(): Promise<ToolDescriptor[]> {
    if (this.tools) return this.tools;
    const result = (await this.rpc("tools/list")) as { tools?: ToolDescriptor[] } | undefined;
    this.tools = Array.isArray(result?.tools) ? result.tools : [];
    return this.tools;
  }

  /**
   * Call a tool by name, going through `tool_execute` when the name is not in
   * the listed subset. The result is the parsed JSON of the first text block
   * when it parses, otherwise the raw text.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const listed = (await this.listTools()).some((t) => t.name === name);
    const call = listed
      ? { name, arguments: args }
      : { name: "tool_execute", arguments: { toolName: name, arguments: args } };
    const result = (await this.rpc("tools/call", call)) as ToolCallResult | undefined;

    if (result?.isError) {
      const text = result.content?.find((c) => c.type === "text")?.text ?? "(no detail)";
      throw new AgentOsError(`Tool ${name} returned an error: ${text.slice(0, 300)}`);
    }
    if (result?.structuredContent !== undefined) return result.structuredContent;
    const text = result?.content?.find((c) => c.type === "text")?.text;
    if (text === undefined) return result;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

/** Parse either a JSON body or an SSE body down to the reply for `id`. */
function parseReply(body: string, contentType: string, id: number): JsonRpcReply {
  const tryJson = (s: string): JsonRpcReply | null => {
    try {
      return JSON.parse(s) as JsonRpcReply;
    } catch {
      return null;
    }
  };

  if (!contentType.includes("text/event-stream")) {
    const parsed = tryJson(body);
    if (parsed) return parsed;
    throw new AgentOsError(`Binance's MCP server sent a body that is not JSON: ${body.slice(0, 120)}`);
  }

  // One `data:` line per message. The reply we want is the one carrying our id;
  // anything else on the stream (notifications, keep-alives) is not ours.
  let last: JsonRpcReply | null = null;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const parsed = tryJson(line.slice(5).trim());
    if (!parsed) continue;
    if ((parsed as { id?: number }).id === id) return parsed;
    last = parsed;
  }
  if (last) return last;
  throw new AgentOsError("Binance's MCP server sent an event stream with no JSON-RPC reply in it.");
}

export interface AccountCommission {
  symbol: string;
  maker: number;
  taker: number;
  /** BNB-payment discount, as documented, when the account has it on. */
  discount: { enabled: boolean; rate: number } | null;
}

/** The commission tool's name is matched loosely, since only its suffix is documented. */
const COMMISSION_TOOL = /accountCommission$/i;

/**
 * Read the account's real commission rates for one symbol.
 *
 * Returns null when the server offers no such tool — the granted scopes may
 * not include account data — so the caller falls back to the public schedule
 * with a reason rather than failing the quote. Any other problem throws, since
 * a session that exists and then refuses is something the operator should see.
 */
export async function fetchAccountCommission(
  client: AgentOsClient,
  symbol: string,
): Promise<AccountCommission | null> {
  const tools = await client.listTools();
  const tool = tools.find((t) => COMMISSION_TOOL.test(t.name));
  // Not in the listed subset: try the documented-by-observation name through
  // tool_execute. If the server does not know it either, that is a clean null.
  const name = tool?.name ?? "spot.accountCommission";

  let raw: unknown;
  try {
    raw = await client.callTool(name, { symbol: symbol.toUpperCase() });
  } catch (err) {
    if (!tool && err instanceof AgentOsError && /unknown|not found|no such/i.test(err.message)) {
      return null;
    }
    throw err;
  }

  const r = raw as {
    symbol?: string;
    standardCommission?: { maker?: string | number; taker?: string | number };
    discount?: { enabledForAccount?: boolean; enabledForSymbol?: boolean; discount?: string | number };
  } | null;

  const maker = Number(r?.standardCommission?.maker);
  const taker = Number(r?.standardCommission?.taker);
  if (!r || !Number.isFinite(maker) || !Number.isFinite(taker) || maker < 0 || taker < 0) {
    throw new AgentOsError(
      `The commission reply for ${symbol} did not carry standardCommission.maker/taker as numbers: ` +
        `${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  // A rate of one or more is not a rate. Binance expresses these as fractions
  // (0.001 = 0.1%), and anything else is a misread that would swing the venue.
  if (maker >= 1 || taker >= 1) {
    throw new AgentOsError(`Implausible commission for ${symbol}: maker ${maker}, taker ${taker}.`);
  }

  const d = r.discount;
  const discountRate = Number(d?.discount);
  const discount =
    d && typeof d.enabledForAccount === "boolean"
      ? {
          enabled: d.enabledForAccount === true && d.enabledForSymbol !== false,
          rate: Number.isFinite(discountRate) ? discountRate : 0,
        }
      : null;

  return { symbol: r.symbol ?? symbol.toUpperCase(), maker, taker, discount };
}
