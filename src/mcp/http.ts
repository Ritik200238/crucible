/**
 * The MCP server over HTTP, so it can be hosted.
 *
 * Stdio is right for a local agent and useless for anyone else: it means "clone
 * the repository". Streamable HTTP means one URL an agent anywhere can be
 * pointed at. The tools are the same; only the pipe differs.
 *
 * Stateless by design. Every request builds a fresh server and transport and
 * tears them down when the response closes. Nothing about a session lives on
 * this side except the plan store, which is deliberately shared: `route` and
 * `execute` are two requests, and the plan has to survive between them.
 *
 * A public instance is read-only unless the caller proves otherwise. `quote`,
 * `route`, `policy`, `evidence`, `calibration`, `verify_ledger` and `status`
 * answer anyone; `execute` and `reconcile` refuse without the operator's token.
 * That is what lets the same URL be handed to a stranger and a hosted agent:
 * the stranger can watch everything and move nothing.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { buildServer } from "./server.ts";

export interface HttpMcpOptions {
  /**
   * When set, mutating tools require `Authorization: Bearer <token>` matching
   * this value. When unset, the instance is local and every tool is open —
   * loopback is the operator.
   */
  operatorToken?: string;
}

/** Constant-time comparison; a token check must not leak its length or prefix. */
function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerOf(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1];
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  return JSON.parse(text);
}

/**
 * Serve one MCP request.
 *
 * Returns after the response has been handed to the transport. Errors before
 * that point are answered as JSON-RPC errors so an agent sees a reason rather
 * than a dropped connection.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: HttpMcpOptions = {},
): Promise<void> {
  if (req.method !== "POST") {
    // The transport supports GET for server-initiated streams and DELETE for
    // sessions; a stateless server has neither, and says so in the protocol's
    // own terms rather than with a bare 405.
    res.writeHead(405, { "content-type": "application/json", allow: "POST" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "This MCP endpoint is stateless and answers POST only." },
        id: null,
      }),
    );
    return;
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32700, message: "The request body is not JSON." },
        id: null,
      }),
    );
    return;
  }

  const mutationsAllowed = opts.operatorToken === undefined || tokenMatches(bearerOf(req), opts.operatorToken);
  const server = buildServer({
    mutationsAllowed,
    readOnlyReason:
      "This instance is public and read-only. Every read tool answers; execute and reconcile need " +
      "the operator's token in an Authorization: Bearer header. Nothing was sent.",
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // One JSON body per reply. A JSON client is the common case for an agent
    // runtime and it keeps curl and the test suite simple; the transport still
    // negotiates SSE when a client insists.
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: `The server failed to handle the request: ${(err as Error).message}` },
          id: null,
        }),
      );
    }
  }
}
