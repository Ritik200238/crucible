# Binance Agent OS Mini Hackathon — everything known

Reference notes for the entry. Facts here were read from Binance's own pages or
probed live from this machine. Anything not verified is labelled as such rather
than smoothed over.

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

## 9. Verified versus not verified

**Verified** — read from Binance's own pages or probed live from this machine:

- Every prize figure, entry step, eligibility exclusion and survey link
- Every Agent OS endpoint, tool name, CLI command and fee above
- That `baw` installs and runs, reports `UNCONNECTED` without a session, and
  returns a clean `NOT_LOGGED_IN` for wallet settings
- That public BSC RPC and the PancakeSwap V3 quoter answer from this network
- That Binance spot depth, book ticker, filters and trade feeds answer from this
  network

**Not verified:**

- Whether the track has official sub-themes beyond the two published tracks
- The total number of entries, and therefore the real odds against 53 places
- Any judging criteria, because none were published

---

## 10. Official links

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
