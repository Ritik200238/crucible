# Crucible — build plan

Smart execution for Binance agents. The agent says *what* to trade. Crucible
decides *where* and *how*, executes it through Binance Agent OS, and proves the
result with a receipt that compares what it predicted to what actually happened.

This document is the spec. Everything in it was checked against Binance's own
documentation or a live probe from this machine on 2026-09-08. Where something
is assumed rather than verified, it says so.

---

## 1. What we are building

### The problem

Every AI agent on Agent OS places a market order and quietly pays the spread,
the fee, and the impact. Nobody measures that cost. Nobody improves it. The two
strongest entries in this hackathon both proved the point without building the
answer:

- One built a gate that decides *whether* an agent may trade. It never touches
  how the order fills.
- The other built a single arbitrage and concluded, in its own words, that "the
  round trip is the whole game, and execution style decides it." Then it built
  one strategy instead of the execution layer.

### The product

For any order, Crucible:

1. **Prices it on both venues at the same instant** — Binance spot (fee, spread,
   book impact) and on-chain via the Binance Agentic Wallet (pool fee, price
   impact, gas, wallet service fee). All-in, in basis points of mid.
2. **Picks the cheaper venue and the right style** — a single order, or worked
   over time in slices when the size would move the book.
3. **Runs it through the risk engine** — size, concentration, daily loss,
   cooldown, plus execution-specific limits (max impact, max slippage, minimum
   depth, stale-quote age).
4. **Executes through Agent OS** — the Binance MCP server for the exchange leg,
   the Agentic Wallet CLI for the on-chain leg.
5. **Confirms the fill by re-reading the venue**, never by trusting the
   response that placed it.
6. **Issues a receipt**: predicted cost, realised cost, what the other venue
   would have cost, and the difference in dollars.

Every decision is deterministic, fingerprinted, and appended to a signed ledger.

### In one sentence

*The agent that makes every trade cheaper and can prove it.*

---

## 2. Why this wins

Both leading competitors built machines whose identity is refusal. Their demos
end with "the agent declined." Binance built Agent OS so agents would trade,
pay, and operate on-chain, and its own playbook says to combine the tools.

Crucible is the entry that:

| | Them | Crucible |
|---|---|---|
| Demo ends with | A refusal | A real fill and a dollar figure |
| Agent OS surfaces used | MCP server; wallet listed but never executed | MCP server **and** Agentic Wallet, both executing for real |
| Category | Safety gate | Execution quality — empty lane |
| Positive or defensive | Defensive | Positive, and still gated |
| Evidence artefact | Funding history / rejected sweep | Days of measured CEX-vs-chain cost, regenerable from public data |

The strongest competitor's own code admits its on-chain path is "built, the
credential is not present." Ours will have transaction hashes.

### Where this stays honest

- Savings will sometimes be a few basis points, and sometimes Binance is simply
  cheaper. The receipt says whichever is true. "Binance spot was cheaper 71% of
  the time at $500" is a publishable finding, not a failure.
- A maker order's cost is an estimate weighted by fill probability. The report
  labels it as such.
- Demo Mode is not mainnet. Mainnet execution sits behind an explicit switch.

---

## 3. How it works

### 3.1 The snapshot

A single deterministic object, timestamped, hashed, and stored with every
decision. Everything downstream is a pure function of it.

| Field | Source | Verified |
|---|---|---|
| Order book, top 100 | `spot.depth` via Binance MCP, or `GET /api/v3/depth` | Yes — weight 5 at limit ≤100 |
| Best bid/ask | `spot.tickerBookTicker` / `GET /api/v3/ticker/bookTicker` | Yes — live spread on BNBUSDT was 0.13 bps |
| Symbol filters | `spot.exchangeInfo` — `LOT_SIZE.stepSize`, `PRICE_FILTER.tickSize`, `NOTIONAL.minNotional` | Yes |
| Real commission rates | `spot.accountCommission` — `standardCommission.maker/taker`, `discount` | Yes. VIP0 is 0.1%/0.1%, 0.075% paying in BNB |
| On-chain quote, every fee tier | PancakeSwap V3 QuoterV2 `quoteExactInputSingle` via public BSC RPC | Yes — probed live: 1 WBNB → 753.05 USDT on the 0.01% pool while Binance bid was 754.38 |
| Executable on-chain quote | `baw market-order quote --json` | Yes — returns `toCoinAmount` and `slippage` |
| Gas | `eth_gasPrice` via public RPC | Yes — 0.05 gwei; a swap costs well under a cent |
| Wallet service fee | Binance Wallet fee schedule | Yes — **0% for BNB↔USDT** (Group 1 ↔ Group 1); 0.5% into unlisted tokens |
| Wallet daily quota | `baw wallet settings --json` (`quotaLeft`) | Yes — read-only, set in the Binance App |

### 3.2 The cost model

All figures in basis points of the Binance mid at snapshot time.

**Binance, taker (MARKET):**
`taker_fee + half_spread + book_impact`, where impact walks the real depth for
the order size. Fee comes from the account, not a constant.

**Binance, maker (LIMIT_MAKER at best bid/ask):**
`maker_fee + (1 − p_fill) × cost_of_missing`, where `p_fill` is estimated from
queue size ahead at that level and recent trade rate. Labelled an estimate.
At VIP0 maker and taker fees are identical, so posting saves only the spread —
which on BNBUSDT is 0.13 bps. Crucible will say that out loud rather than
recommend posting by reflex.

**On-chain (Agentic Wallet → PancakeSwap V3):**
`pool_fee + price_impact + gas_usd/notional + wallet_service_fee + slippage_reserve`.
Pool fee and impact come from the quoter output on every tier (0.01%, 0.05%,
0.25%, 1%); the best tier is chosen per size. Gas is priced live. The wallet's
own quote is fetched for the executable path and reconciled against the RPC
quote; a disagreement above a threshold is a refusal, not a shrug.

### 3.3 The decision

Pure function `(intent, snapshot, policy) → plan`. The plan carries:

- venue, style (single or sliced), child schedule if sliced
- the full side-by-side cost table
- a fingerprint: SHA-256 of intent + snapshot hash + policy hash
- a 60-second TTL. An expired plan cannot execute; it is re-priced and
  re-gated, never replayed.

Same inputs, byte-identical plan. Tested.

### 3.4 The risk engine

The eleven rules already built (order size, concentration, leverage, daily
loss, daily volume, post-loss cooldown, hourly runaway brake, symbol and market
allowlists, no-trade windows, human escalation) plus execution rules:

| Rule | Refuses when |
|---|---|
| `max_impact_bps` | The book walk exceeds the limit |
| `max_slippage_bps` | Quote-to-execution drift exceeds the limit |
| `min_depth_notional` | Too little resting liquidity within X bps |
| `snapshot_max_age_ms` | The snapshot is stale |
| `venue_allowlist` | The chosen venue is not permitted |
| `onchain_quota` | The wallet's `quotaLeft` cannot cover the leg |
| `quote_disagreement_bps` | RPC quote and wallet quote diverge |

One BLOCK blocks. Risk-reducing orders keep their exemptions.

### 3.5 Execution

**Binance leg — through Agent OS.** The Binance MCP server at
`agent.binance.com/mcp/agentic`: Streamable HTTP, JSON-RPC, bearer token from
`claude mcp login binance-mcp-server` (stored under `mcpOAuth` in Claude Code's
credential file, or supplied as `BINANCE_MCP_TOKEN`). The `Accept` header must
list both `application/json` and `text/event-stream`. Hidden tools go through
`tool_execute`. Sequence: `spot.orderTest` → `spot.newOrder` with
`newOrderRespType=FULL` → `spot.getOrder` until terminal → `spot.myTrades` for
the real fills, `commission`, and `isMaker`.

**Binance leg — REST fallback.** Same endpoints on `demo-api.binance.com`
(Demo Mode: live-like books, identical filters and limits, resettable balance)
or mainnet. Ed25519 signing, `recvWindow` 5000. Demo Mode is the default;
mainnet requires `CRUCIBLE_LIVE=1` and `"mode": "live"` together.

**On-chain leg.** `baw market-order swap --json` → `orderId` → poll
`baw market-order list --orderId … --json` until `FINISHED` or `FAILED` →
`txHash` → `eth_getTransactionReceipt` for independent confirmation. Binance's
own documentation is explicit that an `orderId` is not a completed swap; the
poll is mandatory. On-chain execution is real BSC mainnet at small size — the
wallet has no testnet — with the daily limit set low in the Binance App.

**Sliced execution.** When predicted impact exceeds the policy threshold, the
plan becomes N children over T minutes. Each child is re-snapshotted, re-priced,
re-gated, and separately confirmed. The receipt aggregates them.

### 3.6 The receipt

```
crucible receipt 7f3a2c
  intent      BUY 0.65 BNB (~$490)
  chosen      Binance spot, taker            predicted  10.2 bps
  alternative on-chain, 0.01% pool           predicted  17.6 bps
  realised    10.4 bps  (fill 754.41, fee 0.000650 BNB)   error +0.2 bps
  saved       7.2 bps  =  $3.53  versus the other venue
  confirmed   spot.getOrder FILLED · myTrades 1 fill · isMaker false
```

Predicted-versus-realised error, tracked over time, is the product's own honesty
metric. It is published on the dashboard.

### 3.7 The ledger

Append-only JSONL. Each record carries the SHA-256 of the previous record and
the whole file is Ed25519-signed with a key held only by the operator. A
tampered line breaks the chain at exactly that line. The dashboard re-derives
the chain in the browser with `crypto.subtle` alone.

### 3.8 The evidence document

A sampler runs from day one: every ten minutes, for three sizes ($100, $1,000,
$10,000) on BNBUSDT and ETHUSDT, it snapshots both venues and records the
all-in cost of each. Public endpoints only, no keys. At submission it becomes
`docs/EXECUTION_EVIDENCE.md`: share of samples where each venue was cheaper,
mean and median saving, by size and hour — with the script that regenerates
every number. It starts early because it needs elapsed time, not effort.

---

## 4. Surfaces

| Surface | What it offers |
|---|---|
| **MCP server** (stdio, and Streamable HTTP when hosted) | `quote` (both venues, no execution), `route` (plan + fingerprint, 60 s TTL), `execute(plan_id)`, `status`, `report` (execution quality over time), `policy`, `ledger_verify` |
| **CLI** | The same operations, for humans and for the video |
| **Dashboard** | One static page served by the server: live two-venue quote, decision feed, receipts, cumulative saving, predicted-vs-realised error, ledger verification button. Real data only. |
| **Skills Hub skill** | `SKILL.md` per the repository's contribution rules; opened as a pull request to `binance/binance-skills-hub` |
| **Landing page** | Short, honest, with the numbers from the evidence document |

### Hosting

The Agentic Wallet session and the MCP token live on a machine the operator
controls, so execution cannot run in a serverless function. Plan: one Node
process on a small VPS behind nginx serving the MCP endpoint and the dashboard,
with the wallet signed in there; a Vercel-hosted landing page in front. This is
the same shape the strongest live-execution competitor used, and it is the
honest one.

---

## 5. Execution plan

Ten days, in priority order. Each tier is a complete, shippable product on its
own. If time runs out, we ship the last completed tier and state what is absent.

### Day 0 — things only you can do

- Binance account. Enable Demo Mode and create a Demo API key
  (`demo.binance.com/en/my/settings/api-management`).
- `claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic`
  then authenticate, so the Agent OS token exists on this machine.
- Binance App: create the MPC wallet, then sign in to the Agentic Wallet
  (`baw auth signin`, scan, `baw auth verify`). Set the daily limit low. Fund it
  with roughly $20 of BNB and USDT on BSC.
- Follow @Binance and repost the announcement. Complete the survey.
- Confirm you are outside the excluded jurisdictions.

### Tier 1 — the core (days 1–3)

1. Snapshot: spot depth, book ticker, filters, commission; on-chain quoter on
   every tier; gas. Deterministic, hashed.
2. Cost model for all three paths. Unit-tested against hand-computed cases.
3. Decision function, fingerprint, TTL.
4. Risk engine integration plus the execution rules.
5. Ledger with hash chain and signature.
6. **Start the evidence sampler.** It runs for the rest of the build.
7. CLI: `quote`, `route`.

### Tier 2 — real execution (days 3–5)

8. Binance leg through the MCP server, with `orderTest` first and fill
   confirmation by re-read. REST path on Demo Mode as the fallback.
9. On-chain leg through `baw`, with polling and receipt confirmation.
10. The receipt: predicted, realised, alternative, saved.
11. CLI: `execute`, `status`, `report`.

### Tier 3 — the product (days 5–7)

12. Sliced execution with per-child re-pricing and gating.
13. MCP server, stdio and HTTP. Hosted on the VPS.
14. Dashboard.
15. Adversarial test suite: replayed plan, expired plan, tampered ledger line,
    stale snapshot, quote disagreement, split-to-evade-cap, restart-resets-halt,
    wallet quota exhausted, `FAILED` swap reported as success, response-trusted
    fill without re-read.

### Tier 4 — the submission (days 7–10)

16. Evidence document generated from the sampler.
17. Skills Hub skill and pull request.
18. README: first screen is the receipt; then how it works; then honest
    boundaries. A numbers guard fails the build if a quoted figure drifts from
    its source.
19. Landing page.
20. Video, 60–90 seconds: two venues priced live → a real Binance fill with
    receipt → a real on-chain fill with a transaction hash → an oversized order
    blocked → the ledger verified in the browser. Ends on a dollar figure.
21. Tweet, survey, done.

---

## 6. Risks, stated plainly

| Risk | Mitigation |
|---|---|
| Wallet session expires at 48 h | Sampler and server check `wallet status`; alert to re-sign before demos |
| MCP token expires | Detect 401, re-login flow documented; REST fallback keeps execution alive |
| An on-chain swap returns `FAILED` | Handled as a first-class outcome and reported as one — never as success |
| Rate limits (429/418) | Weight budgeting per minute; depth at limit 100 only; backoff on `Retry-After` |
| Demo Mode maintenance | REST mainnet path exists; dashboard shows venue health |
| Savings turn out small | Report the truth. The measurement itself is the product |
| Scope | The tiers. Tier 1 alone is a complete, honest tool |
| No published rubric | Cover every plausible axis: novelty, Agent OS depth, rigour, finish, video |

---

## 7. Honest boundaries (goes in the README verbatim)

- Cross-venue routing covers pairs that exist on both Binance spot and
  PancakeSwap V3 with USD-pegged quotes. BNBUSDT and ETHUSDT first.
- Maker-order cost is a probability-weighted estimate, not a guarantee.
- Demo Mode fills are realistic, not real. Mainnet is opt-in.
- On-chain execution is real mainnet at small size. Gas and pool fees are
  charged for real.
- One operator, one wallet session, one policy. Not multi-tenant.
- Crucible improves how an order fills. It does not claim to know whether the
  order should exist.

---

## 8. What is verified and what is not

**Verified (docs or live probe, 2026-09-08):** every endpoint, parameter, fee,
limit, contract address, tool name, and CLI command named above; the `baw` CLI
installs and runs on this Windows machine (1.9.1); public BSC RPC and the
PancakeSwap quoter answer from this network; Binance spot depth answers from
this network.

**Not verified:** that this machine can complete the Binance MCP OAuth flow
(no token exists here yet); the exact `p_fill` estimator's accuracy (it will be
measured by the receipt error and reported); whether Demo Mode order books
diverge materially from mainnet at $10,000 size (the sampler will show it).
