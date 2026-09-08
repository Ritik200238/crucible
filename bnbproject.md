# Crucible

**Smart execution for Binance agents.** Your agent decides *what* to trade.
Crucible decides *where* and *how* — and proves what it cost.

This document is written for someone who knows nothing about the project. It
covers what it is, what it does, how it works, what is finished, and what is
not. The last part is included on purpose: a tool that measures small numbers
has no business being vague about its own limits.

---

## 1. The problem, in one paragraph

When an AI agent buys crypto, it places a market order on Binance and pays the
commission, the spread, and the cost of moving the book. Those three are
routinely larger than the edge the strategy was chasing. Almost nothing measures
them.

Binance Agent OS already gives an agent two ways to buy the same asset — the
exchange, and on-chain through the Agentic Wallet. **They do not cost the same,
and which one is cheaper changes with the size of the order.** Nothing chooses
between them per order.

## 2. What Crucible is

A router that sits between the agent and the money.

The agent says *buy $1,000 of BNB*. Crucible prices that exact order on both
venues at the same instant, picks whichever fills it cheapest, checks it against
the operator's risk rules, executes it, confirms the fill by reading it back
from the venue, and issues a receipt comparing what it predicted to what
actually happened.

It does not decide whether a trade is a good idea. It makes the trade you have
already decided on cost less, and shows its working.

---

## 3. What we found

This is the finding the product is built around. Every figure is computed from
recorded samples by a script, not typed by hand.

Cost is quoted in **basis points** — one basis point is 0.01%, so 10 bps on a
$1,000 order is $1.00.

| Pair | Order size | On-chain cheaper | Median on-chain | Median Binance |
|---|---|---|---|---|
| BNBUSDT | $100 | 100% | ~2 bps | ~10 bps |
| BNBUSDT | $1,000 | 100% | ~2 bps | ~10 bps |
| BNBUSDT | $10,000 | 100% | ~3 bps | ~10 bps |
| ETHUSDT | $1,000 | 100% | ~5 bps | ~10 bps |
| ETHUSDT | $10,000 | 0% | ~16 bps | ~10 bps |

**The cheaper venue changes with size, and the crossover is different for each
pair.** BNB/USDT stays cheaper on-chain far longer than ETH/USDT, because its
pool is deeper.

That single fact is the entire argument for routing per order rather than
picking a venue once and living with it.

### Why the gap exists

An exchange trade at the standard fee tier pays **0.1%** — ten basis points —
before anything else happens. The deepest BNB/USDT pool charges **0.01%**, one
basis point. The wallet adds nothing on a swap between two major assets, and gas
on BNB Smart Chain is a fraction of a basis point on any order worth routing.

The advantage is real but conditional. It shrinks on a better fee tier, and it
reverses on a large enough order because pool impact grows faster than book
impact.

### A second finding, which changed the product

Posting a passive order at the touch looked cheaper than crossing the spread,
until we measured **adverse selection** — the fact that a resting order does not
fill at random. It fills when somebody chose to trade into it, and that somebody
is more often right than wrong over the next few seconds.

Measured from the trade tape, over roughly 450 fills per symbol: **0.4 to 1.7
basis points**. The half spread a passive order earns is **0.065**.

So posting loses money at the standard fee tier, where maker and taker rates are
identical. The model said the opposite until this was measured and charged.

---

## 4. How it works

### The pipeline

```
intent  →  snapshot  →  costs  →  plan  →  risk  →  execution  →  receipt
```

Every stage after the snapshot is a **pure function** of it. Nothing downstream
reads a clock or a network. Give it the same snapshot and policy and it returns
the same plan, down to the fingerprint — which is what makes a decision
checkable by someone who was not there when it was made.

### Stage 1 — the snapshot

One object, captured at one instant, holding everything a decision is allowed to
depend on:

- Binance order book, best bid and ask, symbol trading rules, real commission
  rates
- The pool's price on **every** fee tier, plus live gas
- Measured trade flow and adverse selection from the tape
- Optionally the wallet's own executable quote, as a second opinion

Both venues are fetched **concurrently**. Sequential calls would compare a
Binance price from one moment against a pool price a second later, and at these
margins that gap is larger than the effect being measured.

The whole thing is hashed. Two snapshots with the same hash produce the same
plan.

**The book is validated before it enters the pipeline.** A crossed market, an
empty side, a price that is not a number, or levels out of price order are all
refused — each of them still walks and still returns a plausible-looking cost,
which is worse than failing.

### Where the commission rate comes from

Commission is the largest single component on the exchange side. Three sources,
tried in order, and every quote says which one it used:

1. **Binance Agent OS.** The exchange's own MCP server, authorised once by the
   user from their own client. Crucible finds that session — from Claude Code's
   credential store, or `BINANCE_MCP_TOKEN` — and asks it for
   `account/commission` on the symbol. No API key on this machine. The session
   is used to read; orders still go out on the signed execution path.
2. **An API key in the environment**, through the signed REST endpoint for the
   same figure.
3. **The public VIP 0 schedule**, labelled as such on every report, with the
   reason the real rate was not available.

The Agent OS client speaks the documented transport, and the hidden-tool
mechanism was verified against the live server on 2026-09-08 with the
operator's own session: `tools/list` returned 50 tools, the commission tool was
not among them, and `tool_execute` with `spot.accountCommission` answered with
the documented REST shape. `status` then read the account's real rate: maker
10.00 bps, taker 10.00 bps, BNB discount on. If a later change breaks any of
this the result is a labelled fallback, never a wrong number presented as the
account's — which the tests pin by breaking the decoder, the auth header and
the cache in turn.

The BNB fee discount was settled by a real fill rather than by reading. The
docs caption `discount.discount` as the rate the commission is "reduced by"
and show it as both 0.25 and 0.75 in different examples of the same field, so
the wording could not say whether 0.75 meant the discount or the fraction
remaining. On 2026-09-08 order 7070626547 bought 0.013 BNB at a standard 0.1%
with the field reporting 0.75, and was charged 0.00000975 BNB — 7.5 basis
points, which is 0.75 x 0.1%. It is the fraction still paid. The discount is
applied from that point, the standard rate is kept and reported beside it, and
the note says the discount lapses when the account runs out of BNB to pay fees
with.

### Stage 2 — the cost model

Three routes priced on one comparable axis:

**Binance, crossing the spread** — commission, half the spread to reach the
touch, and the impact of walking however many levels the size needs. The last
two come from the live book, not a constant.

**Binance, posting at the touch** — the fee and the spread earned, both weighted
by the chance of actually filling, plus the cost of being picked off, plus the
cost of missing and having to cross later.

**On-chain** — the pool fee, the price impact, gas, and the wallet's service
fee. Every fee tier is quoted and the best-paying one wins, because which tier
is cheapest depends on size: the tightest-fee pool has the least room.

Two details that took work to get right:

- **Impact and venue divergence are separated** using a near-zero-size reference
  quote from the same pool. Measuring impact against the Binance mid would
  conflate how far the order pushes the pool with how far the pool had already
  drifted, and only the first is a cost of trading.
- **Fill probability is measured, not assumed.** A resting order clears once
  enough volume has crossed to work through the queue ahead of it plus itself,
  so the model reads real trade flow. A larger order is *less* likely to fill —
  the opposite of what a naive queue-ratio model says.

Risks that carry **no expected cost** are named rather than priced. An on-chain
swap settles over several blocks and the pool moves in that window; it can also
fail on slippage and still cost gas. Average drift is zero, so there is no
honest number to charge — but the exchange route does not carry either risk, and
a cheaper number that hides one is not cheaper.

### Stage 3 — the plan

The cheapest route wins, with one deliberate exception: **a route whose cost is
modelled does not beat a measured one unless it wins by more than the modelling
could plausibly be wrong by.**

The plan carries a fingerprint over the intent, the snapshot and the policy, and
expires after sixty seconds. Market state at these margins goes stale in
seconds, so a plan is re-priced rather than replayed.

When a single order would move the book past the operator's impact limit, the
plan becomes several children spaced over time, each re-priced and re-gated
separately.

### Stage 4 — the risk engine

**Seventeen deterministic rules.** Eleven gate any order; six are specific to
execution.

| | |
|---|---|
| Size | per-order cap, daily volume cap, position concentration |
| Behaviour | daily loss circuit breaker, post-loss cooldown, hourly rate brake |
| Scope | symbol allowlist, market allowlist, venue allowlist, no-trade windows |
| Escalation | large orders require a human |
| Execution | book impact, slippage, resting depth, snapshot age |
| Believability | disagreement between the two on-chain price sources, and a bound on how far a venue may sit from the exchange before it is believed at all |

**One BLOCK blocks the order**, regardless of how many rules passed. Safety rules
that can be outvoted are not safety rules.

**Risk-reducing orders keep their exemptions.** A cap that blocks the order
closing a losing position traps you in exactly the trade you wanted out of.

**The cumulative rules count what actually executed**, rebuilt from the ledger
rather than a counter file. That is what stops an order too large for the
per-order cap simply arriving eighty times instead of once.

### Stage 5 — execution

**On the exchange:** the order is validated by Binance's own `order/test` before
anything is sent. Then placed, then **read back**. The fill, the price, the fee
and the maker flag come from the trade records — never from the response that
placed the order.

**On-chain:** through the Agentic Wallet CLI, which holds its own key and
enforces its own daily limit. This process never sees a private key. Binance's
documentation is explicit that a swap returning an order id has only been
*submitted*, so it is polled to a terminal state, and a failed swap is reported
as failed rather than as a success with a missing hash.

Two independent switches are required before anything is transmitted: the policy
must say `live`, **and** an environment variable must be set in the shell by a
person. A config file an agent could edit is not on its own enough to move real
money.

**A write is a lifecycle, not an event.** The order is recorded the instant the
venue accepts it — `execution.submitted`, with the venue's own id — before any
attempt to learn what became of it. If the read-back then fails, the result is
`execution.unconfirmed`, which is a different thing from `execution.failed`: a
failure means nothing was sent and may be retried; unconfirmed means something
was sent and must not be. The unconfirmed order's notional is held against every
cap, and counts as an order for the rate brake, until `reconcile` asks the venue
again and writes what it said. Not knowing is never treated as knowing it did
not happen. A slice that filled before a later slice failed is counted too.

### Stage 6 — the receipt

```
predicted 10.13 bps · realised 10.40 bps (price 0.40 + commission 10.00) · error 0.27 bps
saved $0.93 against the other venue
FILLED 2 BNB at 752.05, fee 0.002 BNB — order 12345, confirmed by re-reading the order
```

**The error line is the product grading its own homework.** Realised includes
commission, because the prediction does — a price-only figure would be wrong by
roughly one fee on every fill. When a fee is charged in an asset the fill cannot
price, the comparison is reported as **unavailable with a reason** rather than
folded in as zero.

### The ledger

Every decision — allowed, refused, failed — is appended to a hash-chained,
Ed25519-signed log. Editing any past line breaks the chain at exactly that line.
Deleting trailing records leaves a consistent chain that fails the signed count.

A ledger that only holds successes is a marketing document.

---

## 5. What has been built

| | |
|---|---|
| Source | 23 files, ~8,000 lines of TypeScript |
| Tests | 18 files, ~8,451 lines, **484 tests, all passing** |
| Commits | 45 |
| CI | GitHub Actions, green on **Linux and Windows** |

### Surfaces

**MCP server** — ten tools an AI agent drives: `quote`, `route`, `execute`,
`policy`, `evidence`, `verify_ledger`, `calibration`, `reconcile`, `check_claim`,
`status`.
Over stdio for a local agent, or over streamable HTTP at `POST /mcp` on the
dashboard for a hosted one, with a public read-only mode gated by an operator
token.

The split is deliberate. `quote` prices without deciding. `route` decides and
returns a fingerprinted plan. `execute` takes **only a plan id** — never order
details. An agent therefore cannot execute an order the risk engine has not
already seen, and cannot alter it between the decision and the fill. Any change
produces a different plan that has to clear the gates again.

**CLI** — the same calls in a form a person can read: `quote`, `route`,
`route --execute`, `status`, `policy`, `verify`, `sample`, `samples`. There is
no separate presentation path, so a demo cannot show something the product does
not do.

**Dashboard** — one page, no build step, and **no external requests of any
kind**, enforced by a Content-Security-Policy header rather than asserted in a
comment. Live two-venue quote, the evidence summary, the active policy, and
ledger verification.

**Evidence sampler** — prices both venues every ten minutes and records what
each would have cost. Public endpoints only, nothing executed, no credential
needed. Failures are written down rather than dropped, because discarding the
samples where one venue was unreachable would bias the result toward whichever
happened to be answering.

**Evidence document** — regenerated from the samples by a script. Nothing in it
is typed by hand, and a build check fails if the README or the document drift
from the data behind them.

**Skills Hub skill** — packaged for submission to Binance's open skills
repository.

---

### Skills Hub skill

`skills/crucible/` is a Binance Skills Hub skill: `SKILL.md` with the hub's
frontmatter and trigger phrases, `references/tools.md` describing all ten
tools, and `scripts/crucible.sh` for runners without MCP. `.mcp.json` at the
repository root registers Crucible beside `binance-mcp-server` so both sit in
one Claude Code session.

### What the agent may say

`check_claim` holds a summary to the ledger before it reaches the user: every
figure must be one a record carries at the precision written, a trade may only
be called done with a confirmed fill behind it, an unresolved order may not be
called done, and a refusal that happened may not be left out. Forecasts and
advice are refused outright. Every refusal returns a correct summary built by
concatenating records, never by generation.

## 6. Sixteen bugs found by attacking it

These are listed because they are the most honest thing in this document. **Not
one of them came from reading the code.** Reviewing found nothing. Trying to
break it found sixteen, three of which could move real money to the wrong place.

| # | Bug | Why it mattered |
|---|---|---|
| 1 | A venue price 99% below the exchange priced at −9,900 bps and the router sent the order there | A stale feed, a wrong token, or a moved pool all look exactly like this |
| 2 | Four cumulative rules read counters hardcoded to zero and could never fire | An order too large for the cap could arrive eighty times instead of once |
| 3 | The realised cost omitted commission entirely | The product's own honesty metric was wrong by a full fee on every fill |
| 4 | Fill probability was inverted | It recommended posting a large order *because* it was large |
| 5 | Adverse selection was not modelled at all | It recommended posting when posting loses money |
| 6 | The two-source price check compared against a quote that was never fetched | A gate that read as protection while protecting nothing |
| 7 | A negative book level corrupted the walk | One bad level produced an average price available at no venue |
| 8 | A crossed, empty, unsorted or NaN book still returned a cost | A number with no market behind it, treated downstream as real |
| 9 | A plan could be replayed inside its own minute | The docs claimed single use; only expiry was enforced |
| 10 | Fees split across assets picked the largest raw number | 0.9 USDT beat 0.002 BNB, which is worth more. Money vanished from receipts |
| 11 | The snapshot hash omitted fields the decision reads | The stated reproducibility guarantee was not true |
| 12 | The size resolver promised "exactly one" and silently preferred one | A contradictory intent was routed rather than refused |
| 13 | Gas was priced at the traded pair's price rather than BNB's | Gas is always paid in BNB. On BTC this overstated it 104× and invented sixty basis points of cost |
| 14 | The wallet fee was looked up by the exchange's asset name, not the chain's | `BTC` found no entry where `BTCB` was the contract, so the lookup missed on exactly the pairs where the fee decides the venue |
| 15 | A read-back that timed out was recorded as a failure | The order had reached the exchange. Recorded as failed, it vanished from every cap, and a slow network became a way to erase orders from the daily total |
| 16 | Half a round trip is fractional when the round trip is odd, so the signed `timestamp` serialised as `...123.5` | Binance parses that parameter as `^[0-9]{1,20}$` and rejected it outright. Roughly half of all orders failed on nothing but network timing — and only a run of real orders exposed it |

Every one is now covered by a test written from the attacker's side. A rule only
ever fed the input it was designed to catch has not really been tested.

Nine of them are also re-run as attacks rather than as assertions.
`demo/attack.ts` drives the real modules, prints what stopped each attempt and
where, and exits non-zero if any of them starts working again. The split-order
case reproduces the original bug first — eighty slices through an evaluator with
no memory, every one accepted — so the defence is measured against the failure
instead of being asserted on its own. CI runs it on both platforms.

---

## 7. What is **not** done

Stated plainly.

### Real executions, on Demo Mode

The exchange path has run for real, fourteen times. The first was order
**7070626547** on 2026-09-08: a $10 buy of BNB, routed, gated, sent to Binance
Demo Mode, and read back — 0.013 BNB at 748.09, commission 0.00000975 BNB. Its
receipt compared 10.07 bps predicted against 7.57 bps realised, and that 2.5 bps
gap is what proved how the BNB discount field reads.

Then a sweep of ten more, buying and selling at $10, $20, $35, $60 and $100.
Since the commission reading was corrected, thirteen fills have a mean error of
**+0.09 bps**, a median of **0.00**, and twelve of the thirteen are exact.

**That result is weaker than it looks, and the reason matters.** These were
small orders on a deep book: impact was zero, nothing rested, and the estimate
was almost entirely commission — which is now read from the account rather than
guessed, so getting it right is arithmetic rather than modelling. The parts of
the model that could actually be wrong — book impact at size, the maker fill
probability, adverse selection — have never been graded, because no order large
enough to move the book has been executed. The single miss, +1.18 bps on a $20
buy, was the price moving between the quote and the fill; that is what the
uncertainty bar exists to describe, not a modelling error.

It was Demo Mode throughout, which is the real matching engine on a practice
account; nothing has been sent to the live exchange. **The on-chain leg has
still never executed** — that needs a signed-in Agentic Wallet session, so the
entire on-chain half of the router is unproven in execution, and until that
changes this sentence stays here.

The pipeline is also proven against a simulated venue in the suite, with the
call sequence asserted exactly:

```
GET  /api/v3/time
POST /api/v3/order/test     ← validation precedes transmission
POST /api/v3/order
GET  /api/v3/order          ← the fill comes from here, never the POST
GET  /api/v3/myTrades
```

### The cost model has one sample

A direct consequence of the above, and worth stating on its own because it is
the claim a reader is most likely to assume has been checked. Every execution
records what was predicted beside what it actually cost, and `calibration` reads
those back and reports the error — signed, per venue, with the worst single miss
kept next to the average.

With no executions on the record it returns exactly that:

> No orders have been executed, so the cost model has never been checked against
> a real fill. Every figure this product reports is a prediction that has not yet
> been graded.

Fitting a calibration curve to zero samples would have produced something that
reads as evidence while being the opposite, so it refuses to. The report also
refuses to describe a tendency below five executions, however consistent they
look.

### Hostable, not yet hosted

The MCP server now runs over streamable HTTP at `POST /mcp` on the dashboard,
stateless, with a public read-only mode: with `CRUCIBLE_MCP_TOKEN` set, every
read tool answers anyone and `execute`/`reconcile` require the token as a
bearer. Without a token it refuses to bind beyond loopback. What remains is a
machine to run it on — a VPS or a container host — and a domain. That is an
operator's action, and until it is done the only way to reach this is to clone
the repository.

### The evidence is young

The sampler restarts whenever the cost model changes, because averaging figures
from two different models would produce a number describing neither. The current
sample is real and regenerable but covers hours, not market cycles.

### Other limits

- **Two pairs.** BNB and ETH against USDT, both with deep pools. A thinner pair
  would look different.
- **Fees default to the public standard schedule** when no account credential is
  present, and every report says so. A real account usually pays less, which
  *narrows* the gap this product reports.
- **Maker cost is an estimate.** It is weighted by a fill probability derived
  from measured flow, and the receipt's error is the check on whether that model
  is any good.
- **One operator, one policy.** Not multi-tenant.
- **Position tracking is average-cost and derived from fills.** It is not a
  full accounting system.

---

## 8. Running it

Node 22 or later. **Quoting needs no credentials at all** — both venues are
priced from public endpoints.

```bash
npm install

node --experimental-strip-types src/cli.ts quote  --symbol BNBUSDT --usd 500      # price every route
node --experimental-strip-types src/cli.ts route  --symbol BNBUSDT --usd 50000    # choose one, and gate it
node --experimental-strip-types src/cli.ts route  --symbol BNBUSDT --usd 2000000  # watch the risk engine refuse
node --experimental-strip-types src/cli.ts status                                  # what can actually execute
node --experimental-strip-types src/cli.ts policy                                  # what is protecting you
node --experimental-strip-types src/cli.ts samples                                 # the evidence so far

npm test              # 484 tests
npm run dashboard     # http://127.0.0.1:8787
bash demo/run.sh      # the whole story, against live prices
```

Connecting it to an agent:

```bash
claude mcp add crucible -- node --experimental-strip-types /absolute/path/to/src/mcp/server.ts
```

Executing needs exchange API keys and a wallet session. `SETUP.md` covers both,
and the safe order to do them in.

---

## 9. The principles it was built on

Each of these was written down before the code and enforced afterwards.

**Nothing is a demo.** Every price is fetched live. There is no mock mode, no
fixture on a path a user can reach, and no number in any document that was typed
rather than computed.

**Never guess.** Every endpoint, parameter, fee, limit and contract address was
read from Binance's own documentation or probed directly. Where something could
not be verified, it says so.

**Refuse rather than answer wrongly.** A pair that cannot be priced in USD is
declined rather than mispriced. A book that cannot be trusted is refused rather
than walked. A fee that cannot be converted makes a comparison unavailable
rather than silently zero.

**State the limits where the claim is made,** not in a footnote.

**A number with no sample count behind it is not evidence.** Every rate in every
report carries its `n`.

---

## 10. In one sentence

Crucible makes the trade you already decided on cost less, proves how much less,
and refuses the ones that should not happen — and it is honest about the one
thing it has not done yet.
