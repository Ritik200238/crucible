---
name: crucible
description: >
  Smart execution for a Binance agent. Before placing a spot order, price the
  same order on Binance spot (taker and maker) and on-chain through the
  Binance Agentic Wallet at one instant, choose the cheaper venue, gate it
  through a deterministic risk policy, execute, confirm the fill by reading it
  back, and receipt predicted against realised cost. Use when a user wants to
  buy or sell a spot asset and cares what it costs to do so, asks "where is
  this cheaper", "what will this trade cost", "route this order", or wants a
  cost-proven execution rather than a market order. Also use before
  summarising what was traded, to check the summary against the signed
  ledger. Do NOT use for choosing what to trade, price prediction, futures,
  margin, or anything that is not a spot buy or sell.
version: 0.1.0
license: MIT
metadata:
  version: 0.1.0
  author: Ritik200238
  license: MIT
---

# Crucible

Your agent decides *what* to trade. Crucible decides *where* and *how*, and
proves what it cost.

An AI agent placing a market order pays the spread, the commission and the
impact, and those three are routinely larger than the edge it was chasing.
Binance Agent OS gives an agent two ways to buy the same asset — the exchange,
and on-chain through the Agentic Wallet — and they do not cost the same. Which
one is cheaper changes with the size of the order. Crucible prices both at one
instant, per order, and routes to the cheaper one.

## What it does

For any spot order, at one instant:

1. **Prices both venues.** Binance spot from the live book (commission, half
   spread, book impact; maker priced with a fill probability and adverse
   selection measured from the tape). On-chain from PancakeSwap V3's own quoter
   on every fee tier, plus gas at the live price and the wallet's service fee.
2. **Picks the cheaper one**, with an uncertainty bar on each estimate.
3. **Gates it** through seventeen deterministic rules the agent cannot change.
4. **Executes and confirms.** The fill is read back from the venue; the placing
   response is never treated as proof.
5. **Receipts** predicted against realised cost, and grades its own model over
   time.

## How to use it

Crucible is an MCP server. Connect it, then let the agent call the tools.

```bash
# local, over stdio
claude mcp add crucible -- node --experimental-strip-types /path/to/crucible/src/mcp/server.ts

# or over HTTP, against a running instance (read-only for anyone without the operator token)
claude mcp add crucible --transport http http://127.0.0.1:8787/mcp
```

The flow an agent follows:

| Step | Tool | What happens |
|---|---|---|
| 1 | `quote` | Price every route. Decides nothing, sends nothing. |
| 2 | `route` | Choose the cheapest, run the policy, return a plan id (single use, 60 s). |
| 3 | `execute` | Execute **by plan id only**. The plan is the authorisation; the order cannot be edited between decision and fill. |
| 4 | `check_claim` | Before telling the user what happened, check the summary against the ledger. |

Read-only at any time: `policy`, `evidence`, `calibration`, `verify_ledger`,
`status`. If `execute` reports an order as **unconfirmed** — sent, outcome not
established — do not retry; call `reconcile` with the plan id.

The scripted path, for a shell or a runner without MCP, is in `scripts/crucible.sh`.

## Rules the agent must follow

- Never describe a trade as done without a confirmed fill and its reference.
- Never retry an unconfirmed order. Reconcile it.
- Never present a cost estimate as proven. `calibration` says how often the
  model has been right; with no executions it says the model has never been
  graded, and so should you.
- The policy is the operator's. If a limit refuses the order, tell the user
  which rule and why; do not look for a way round it.

## What it needs

- Node 22 or later. Quoting needs no key: both venues are priced from public
  endpoints.
- Executing on the exchange needs `BINANCE_API_KEY` / `BINANCE_API_SECRET` and
  the policy set to live. Executing on-chain needs a signed-in Binance Agentic
  Wallet CLI (`baw`).
- Real commission rates, instead of the public schedule, come through Binance
  Agent OS once the user has authorised `binance-mcp-server` in their client.

Reference material: `references/tools.md` (every tool, its arguments and what
comes back), and the project README.

This tool routes and executes a decision the user has already made. It does not
recommend assets, predict prices, or guarantee any outcome. Trading carries
risk; you are responsible for the orders your agent places.
