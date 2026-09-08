# Binance Agent OS Mini Hackathon — everything known

Reference notes for the entry. Facts here were read from Binance's own pages,
probed live, or taken from competitors' published code. Anything not verified is
labelled as such rather than smoothed over.

---

## 1. The event

**Binance Agent OS Mini Hackathon.** A **60,000 USDC** prize pool split across
two tracks, run to get developers building on Binance Agent OS.

Our entry is **Track A**.

## 2. Track A — build an AI agent with Agent OS

**20,000 USDC**, awarded to 53 places:

| Place | Prize |
|---|---|
| 1st | 2,000 USDC |
| 2nd | 1,500 USDC |
| 3rd | 1,000 USDC |
| Next 50 | 300 USDC each |

Those figures sum to **19,500 USDC**, not 20,000. That is Binance's own published
breakdown against its own headline number; the 500 difference is unexplained.

The practical shape of it: the top three are meaningfully different, but fifty
places at 300 make up the bulk. Landing in the 53 is a very different problem
from landing in the top 3.

## 3. Track B — connect and trade

**40,000 USDC.** The first **10,000 eligible users** to connect to the Binance
MCP server and place a trade each receive **4 USDC**.

Not a build track. Separate from Track A, and both can be entered.

## 4. How to enter

There is no submission portal. The entry is a public post on X.

1. **Follow @Binance** and repost the announcement post
2. **Reply or quote-repost** with the submission — for Track A that means a
   **video or demo** plus the **GitHub repository**
3. **Complete the survey**:
   `https://app.binance.com/uni-qr/user-survey/2913aa200aac462c89a737779393f3d4`

All three steps are required. The survey is the one most easily forgotten.

## 5. Eligibility

Not available to users in:

- United States
- United Kingdom
- European Economic Area
- Hong Kong
- Singapore
- Any jurisdiction on Binance's prohibited list

India is not named on that list. The prohibited-countries page is the authority:
`https://binance.com/en/about-legal/list-of-prohibited-countries`

Binance states the hackathon is not an offer or solicitation to trade any
financial product.

## 6. What was never published

**No judging criteria exist.** No rubric, no weightings, no named judges. The
entire brief is "the best agent built with Agent OS".

This is the single largest unknown, and it cannot be optimised for. The only
defensible response is to cover every plausible axis rather than betting on one:
novelty, depth of Agent OS usage, engineering rigour, finish, and a demonstration
that shows a real result rather than a claim.

---

## 7. Binance Agent OS — what it actually is

A developer platform connecting AI agents to Binance. Six surfaces, all verified
against Binance's own documentation.

### Binance MCP Server

- Endpoint: `https://agent.binance.com/mcp/agentic`
- Streamable HTTP, JSON-RPC 2.0, OAuth 2.1 session, bearer token
- `Accept` must list **both** `application/json` and `text/event-stream`
- Runs in META mode: `tools/list` exposes a subset; `tool_search` across 15
  categories reaches the full catalogue, and hidden tools are invoked through
  `tool_execute`
- Spot tool names are prefixed `spot.` — `spot.newOrder`, `spot.orderTest`,
  `spot.getOrder`, `spot.myTrades`, `spot.depth`, `spot.exchangeInfo`,
  `spot.accountCommission`, and others
- Trades run inside a dedicated **Agentic sub-account**, isolated from the main
  account. It must be funded manually; the agent cannot pull funds into it.
- **There is no withdrawal scope.** An agent cannot move funds to an external
  address.
- Scopes are granted individually: market data, account, trade, transfer
- Setup: `claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic`

### Binance Agentic Wallet

- CLI package `@binance/agentic-wallet`, binary `baw` (verified installing and
  running on Windows)
- MPC keyless: the private key is never fully reconstructed, and the agent cannot
  hold or transfer keys
- Chains: BNB Smart Chain (56), Ethereum (1), Base (8453), Solana (CT_501)
- Capabilities: swaps, limit orders, transfers, prediction markets, DeFi
  positions, x402 payments
- Every command accepts `--json`
- Security settings — daily limit, tradable token scope, abnormal-transaction
  handling — are set **in the Binance app only**. The CLI reads them; it cannot
  change them.
- Sign-in is a QR/pairing flow: `baw auth signin` then `baw auth verify`
- **A swap returning an `orderId` is only submitted, not completed.** Binance's
  documentation is explicit: the order can still end `FAILED` on-chain with a
  null transaction hash, so it must be polled to a terminal state.

### Skills Hub

- Open repository: `github.com/binance/binance-skills-hub`
- 19 skills at the time of review, actively maintained, accepts pull requests
- Install: `npx skills add binance/binance-skills-hub/skills/<path>`
- Contribution rules: `SKILL.md` with `name`, `description`, `version`,
  `license` frontmatter; lowercase hyphenated folder names; no promoting any
  asset; no presenting anything as guaranteed or safe; no wallet addresses

### Binance Exchange APIs

- REST and WebSocket, plus FIX
- **Demo Mode**: `https://demo-api.binance.com` — live-like prices and books,
  identical filters and limits to the live exchange, resettable balance. Keys
  created at `demo.binance.com`.
- **Spot Testnet**: `https://testnet.binance.vision` — independent book, balances
  reset monthly, sometimes carries features ahead of production
- Signing: HMAC-SHA256, RSA, or Ed25519, over the query string, with the
  `X-MBX-APIKEY` header. `recvWindow` defaults to 5000 ms and is capped at 60000.
- Rate limits are weight-based per IP. 429 means limited, 418 means banned.

### Binance Pay / x402

Machine-to-machine agent payments. Handled through the wallet CLI's
`x402-payment preview` and `x402-payment sign`. `b402` is the same thing under
Binance's facilitator naming. Subject to its own separate daily quota.

### Web3 APIs

On-chain data and DeFi access, through `web3.binance.com/dev-portal`.

---

## 8. Fee and cost facts, verified

These decide whether a routing product has anything to say, so each was checked
against Binance's own published schedule or probed live.

| Fact | Value |
|---|---|
| Binance spot, VIP 0 | 0.100% maker / 0.100% taker |
| BNB fee discount | 25% off, taking it to 0.075% |
| Binance Wallet swap fee, major asset to major asset | **0%** |
| Binance Wallet swap fee, into an unlisted token | 0.5% |
| PancakeSwap V3 fee tiers on BSC | 0.01%, 0.05%, 0.25%, 1% |
| BNB Smart Chain gas | around 0.05 gwei — a fraction of a basis point on any routed order |

The consequence worth understanding: an exchange trade at VIP 0 pays 10 basis
points before anything else happens, while the deepest on-chain pool charges 1
and the wallet adds nothing between major assets. That gap is real, and it
reverses on a large enough order because pool impact grows faster than book
impact.

---

## 9. The competition

Two entries were examined by cloning and reading their code, not by reading their
claims.

### Governor — `github.com/Pratiikpy/binance-governor`

- 8,626 lines of TypeScript, MIT licensed
- An MCP server that **proxies Binance's own**. Reads pass through; every write
  clears a deterministic policy engine, is validated by `spot.orderTest`, and is
  appended to a hash-chained Ed25519-signed ledger.
- **123 tests — counted directly in the source; the claim is accurate**
- 22 gates. Claims 18 of 18 adversarial attacks blocked, 6 of 6 judge journeys,
  CI on Linux and Windows.
- A second gate asks whether a strategy is statistically supported at all, using
  Deflated Sharpe Ratio and Probability of Backtest Overfitting
- Notable rigour: swept 71 moving-average configurations, then judged the winner
  against the fact that 71 were tried, and refused it. Then randomised the trade
  dates and found random timing scored higher — proving no skill, only a rising
  market.
- Also verifies the **agent's own chat summary** against the ledger, catching
  invented figures, unconfirmed fills, and summaries that are true in every word
  while omitting a refusal
- Found ten defects by attacking its own system, including a daily-loss halt that
  kept its baseline only in memory, so restarting the process turned "down 2.9%,
  blocked" into "0%, allowed"
- Ships a hosted MCP endpoint, a live console, a 90-second video, and a full
  technical writeup
- Its own code states the on-chain path is built but the credential is not
  present — so the wallet leg was never executed

### Deltr — `github.com/mrnetwork0001/Deltr`

- 27,280 lines of Python
- One strategy done thoroughly: delta-neutral basis and funding. Long BNB on
  PancakeSwap V3, short the same quantity of the Binance USDⓈ-M perpetual, so the
  book carries no directional view.
- Prices the **entire round trip** — pool fee, price impact, gas, perp slippage,
  taker fee, both legs, entry and exit — before calling anything actionable, and
  declines when the arithmetic says no
- 683 tests claimed. A 798-line risk gate with 19 ordered checks, zero LLM
  involvement, running in roughly 2 microseconds, producing byte-identical
  decision logs.
- Proposals are single-use, expire in 60 seconds, and are re-priced and re-gated
  at execution
- Itself an MCP server with 22 tools; ships as a Skills Hub skill; executes the
  on-chain leg through the Agentic Wallet and never holds a key
- Claims real mainnet execution with a Binance order ID and a BSC transaction
  hash, plus the three failed attempts before it. **Not independently verified —
  an order ID would not appear in a repository.**
- Analysed 500 days of real funding history. Its headline finding: *"the round
  trip is the whole game, and execution style decides it"* — posting as a maker
  rather than taking is what makes the strategy viable at all.
- Ships a hosted MCP endpoint, a live dashboard with a paper engine running
  continuously, and a video

### What both have in common

Both are, at their core, machines that say **no**. Governor states it directly:
*"I did not build something that trades well. I built the layer that decides
whether an agent is allowed to trade at all."* Deltr's headline is that its own
trade does not currently pay.

Both also explicitly disclaim finding any alpha. Governor cites roughly 150
published studies since 1956 finding no cost-aware, out-of-sample trading edge.

**Neither routes between venues per order.** Deltr proved that execution style
decides profitability and then built one arbitrage; Governor decides whether an
order is allowed and never touches how well it fills.

### Where they set the bar

Anything competitive has to match this level of finish:

- A hosted MCP endpoint a judge can connect to in one command
- A public dashboard showing real data
- A real test suite, adversarially tested
- An evidence document with regenerable numbers
- A short video that shows a result rather than describing one
- Limitations stated plainly rather than omitted

---

## 10. Verified versus not verified

**Verified** — read from Binance's own pages, probed live from this machine, or
counted in competitors' source:

- Every prize figure, entry step, eligibility exclusion and survey link
- Every Agent OS endpoint, tool name, CLI command and fee above
- That `baw` installs and runs, reports `UNCONNECTED` without a session, and
  returns a clean `NOT_LOGGED_IN` for wallet settings
- That public BSC RPC and the PancakeSwap V3 quoter answer from this network
- That Binance spot depth, book ticker, filters and trade feeds answer from this
  network
- Governor's test count

**Not verified:**

- Deltr's claimed mainnet order ID and transaction hash
- Deltr's 683 test count
- Whether "Trading Workflows" — the label Governor used on its entry — is an
  official sub-theme or that entrant's own framing
- The total number of entries, and therefore the real odds against 53 places
- Any judging criteria, because none were published

---

## 11. Official links

| | |
|---|---|
| Hackathon announcement | `https://www.binance.com/en/blog/community/8802181509900814931` |
| Agent OS | `https://www.binance.com/en/agent-os` |
| MCP server docs | `https://developers.binance.com/en/docs/agent-native/mcp-server/agentic` |
| Agentic Wallet docs | `https://developers.binance.com/en/docs/products/agentic-wallet/welcome` |
| Skills Hub | `https://github.com/binance/binance-skills-hub` |
| Docs as one file for an LLM | `https://developers.binance.com/en/docs/llms-full.txt` |
| Survey | `https://app.binance.com/uni-qr/user-survey/2913aa200aac462c89a737779393f3d4` |
| Prohibited countries | `https://binance.com/en/about-legal/list-of-prohibited-countries` |
