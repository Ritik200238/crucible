// The hosted instance, as a serverless function.
//
// Vercel gives every request its own invocation, which suits this exactly: the
// dashboard's handler already treats each request on its own, and the MCP
// transport is stateless by design. Nothing here is a second implementation —
// the request goes to the same `handle` the local server uses, so the hosted
// page cannot show a number the product does not produce.
//
// One thing genuinely does not survive: the in-memory plan store that ties
// `route` to `execute`. That costs nothing here, because a public instance
// refuses `execute` anyway without the operator's token.
//
// Imports the built output rather than the sources, so the bundler sees plain
// JavaScript and never has to resolve a `.ts` extension.

import { handle } from "../dist/src/dashboard/server.js";

export default async function handler(req, res) {
  try {
    await handle(req, res);
  } catch (err) {
    // `handle` answers its own failures, so arriving here means the response
    // itself broke. Say so rather than letting the platform time out.
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `The request could not be answered: ${err.message}` }));
    }
  }
}
