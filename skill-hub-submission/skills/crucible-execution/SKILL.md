---
name: crucible-execution
description: Prices an order on Binance spot and on-chain at the same instant, routes it to whichever fills cheapest, gates it through a deterministic risk engine, and confirms the fill by reading it back from the venue. Use this skill whenever an agent is about to trade and the cost of execution matters, or when a user asks what a trade would actually cost, which venue is cheaper, or how much spread and impact an order is paying.
version: 0.1.0
license: MIT
---

# Crucible

An agent decides *what* to trade. This decides *where* and *how*, and proves what
it cost.

Most agent trading places a market order on one venue and pays whatever the
spread, the commission and the impact come to. Those three are frequently larger
than the edge the strategy was chasing, and almost nothing measures them.

Crucible prices the same order on Binance spot and on-chain at one instant, in
basis points of the same mid, and routes to whichever is genuinely cheaper for
that size.

## When to use it

- Before any trade, to see what each venue would cost
- When a user asks whether an order should go on the exchange or on-chain
- When an order is large enough that book impact matters
- To show what a completed trade actually cost against what was predicted

## The loop

Three calls, in order. The order matters: `execute` accepts only a plan id, so
nothing can be traded that has not already been priced and gated.

### 1. `quote` — what would this cost?

Prices every route and decides nothing. Nothing is sent.

Returns each cost broken into named components: commission, half spread and book
impact on the exchange side; pool fee, price impact, venue divergence, gas and
the wallet service fee on-chain. Components that are modelled rather than
measured are labelled.

### 2. `route` — choose, and gate

Picks the cheapest route, runs the order through the risk engine, and returns a
plan with a fingerprint. The plan expires in sixty seconds.

Seventeen rules gate the order: per-order and daily size caps, position
concentration, a daily loss halt, a post-loss cooldown, an hourly rate brake,
symbol and venue allowlists, book impact, slippage, resting depth, snapshot age,
and disagreement between the two independent on-chain price sources.

A `BLOCK` verdict is final. Do not retry it, do not split the order into smaller
pieces to get under a cap, and do not route it through another tool. Report the
rule that stopped it, in plain language.

### 3. `execute` — send it, then confirm it

Takes a plan id and nothing else. The plan is the authorisation, so the order
cannot be altered between the decision and the fill — any change produces a
different plan, which has to clear the gates again.

The fill is never taken from the response that placed the order. On the exchange
side the order is read back and the price, fee and maker flag come from the trade
records. On-chain, the swap is polled to a terminal state, because a submitted
swap that returns an order id can still end up failing with no transaction hash.

Never tell a user a trade completed on the strength of the call returning. Report
the confirmed fill and its reference.

## Other tools

- `policy` — which rules are in force, and whether execution is enabled
- `evidence` — the recorded venue comparison: how often each was cheaper, by
  symbol and size, with sample counts
- `verify_ledger` — recompute the hash chain over every decision and check the
  signature
- `status` — whether each execution path can actually be reached right now

## What it will not do

- It does not decide whether a trade is a good idea. It makes the trade you have
  already decided on cost less.
- It does not promise a saving. Which venue is cheaper depends on the pair, the
  size and the moment, and on a large enough order the exchange usually wins. The
  answer is whatever the numbers say.
- It cannot move funds anywhere the account has not already authorised. The
  on-chain leg runs through a wallet that holds its own key and enforces its own
  daily limit; this skill never sees a private key.
- It transmits nothing unless the operator's policy says live *and* the
  environment agrees. Two switches, both held by a person.

## Setup

Requires Node 22 or later.

```bash
git clone <your fork> crucible
cd crucible && npm install
```

Add it to an agent:

```bash
claude mcp add crucible -- node --experimental-strip-types /absolute/path/to/crucible/src/mcp/server.ts
```

Quoting works immediately with no credentials — both venues are read from public
endpoints. Executing needs exchange API keys, and the on-chain leg needs a signed-in
Agentic Wallet session.

## Honest limits

- Maker-order cost is a probability-weighted estimate built on measured trade
  flow, not a guarantee that the order fills.
- Cross-venue routing covers pairs that exist on both the exchange and a
  supported pool, quoted against a USD-pegged asset.
- The recorded evidence is measured on a small number of pairs over a limited
  span. It shows the shape of the cost curve and where the cheaper venue changes;
  it does not describe a full market cycle.

Not financial advice. You are responsible for the trades your agent places.
