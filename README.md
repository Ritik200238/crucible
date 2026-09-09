# Crucible

**Smart execution for Binance agents.** Your agent decides *what* to trade.
Crucible decides *where* and *how* — and proves what it cost.

Built for the [Binance Agent OS Mini Hackathon](https://www.binance.com/en/blog/community/8802181509900814931), Track A.

An agent that sends a market order pays the spread, the commission and the
impact — routinely more than the edge it was chasing. Binance Agent OS gives
that agent two venues for the same asset, and they do not cost the same.
Crucible prices both at one instant, routes each order to the cheaper one,
clears it through seventeen deterministic rules, executes, and reads the fill
back from the venue. Then it tells you how wrong it was.

What that has produced so far — every figure checkable in this repository:

- **20 real orders** through the full pipeline on Binance's matching engine,
  each receipted, with a mean prediction error of **0.08 bps**
- **Your real commission and your real equity**, both read through Binance's
  own MCP server — fees at your account's rate, and the risk caps sized to your
  actual balance, not a public schedule and a guessed number
- **17 bugs found by attacking it**, three of which could have moved money to
  the wrong place — all nineteen re-run as attacks in CI on every push
- **500 tests**, none of which need a network
- The maker fill model **graded against the real tape** — and found ~15 bps
  optimistic on deep queues, reported with the number rather than hidden
- A signed, hash-chained ledger you can **verify in your own browser**

**Try it now: [crucible-router.vercel.app](https://crucible-router.vercel.app).**
Quote any pair at any size, route it and watch every rule run, read the
evidence, check the ledger. The app is at [/app](https://crucible-router.vercel.app/app).
Point an agent at it in one line:

```bash
claude mcp add crucible --transport http https://crucible-router.vercel.app/mcp
```

Nine of the eleven tools answer anyone. `execute` and `reconcile` need the
operator's key — a public instance that trades for strangers would be trading
their money — and this one holds no exchange credential, no wallet session and
no signing key, so there is nothing on it to trade with.

```
  CRUCIBLE  BNBUSDT  snapshot 389d3938b3e48d2c
  BUY 0.663469 BNB  ·  $500.00
  mid 753.61500000   spread 0.13 bps   flow 0.41 BNB/s over 239s
  fees: public VIP 0 schedule, not read from an account

  ○ Binance spot taker           10.07 bps ~  ± 0.63  $0.50
      taker fee               10.000   Public VIP 0 taker rate, 0.1000%. Your real rate may be lower.
      half spread              0.066   Reaching the touch at 753.62000000 from a mid of 753.61500000.
      book impact              0.000   The whole order fits on the touch, so it moves the book none.
      effective price      754.37361500
  ○ Binance spot maker           10.25 bps ~  ± 4.48  $0.51
      maker fee                9.318   0.1000% maker rate, weighted by a 93% chance of filling.
      spread earned           -0.062   Resting at 753.61000000 instead of crossing, weighted by fill chance.
      unfilled fallback        0.686   A 7% chance of missing and having to cross later at 10.07 bps.
      adverse selection        0.302   Over the last 219 passive fills on this book the market then
                                       moved against that side by 0.32 bps.
  ● on-chain taker                0.48 bps    ± 1.00  $0.02
      pool fee                 1.000   The 0.01% tier, chosen because it paid out most at this size.
      venue divergence        -0.683   The pool is trading 0.68 bps better than the Binance mid right
                                       now. This is the market, not a saving this product created.
      price impact             0.049   How far this size pushes the pool past its own mid.
      gas                      0.115   $0.0057 at 0.050 gwei, spread over $500.00.
      wallet service fee       0.000   Free: WBNB and USDT are both named in the schedule's first group.
      effective price      753.65125011
  ────────────────────────────────────────────────────────────────────────────
  plan fe53499c5cef   fingerprint fe53499c5cefb250
  on-chain at 1.27 bps beats Binance spot taker at 10.07 bps, a saving of 8.81 bps.

   CLEARED
```

Real output against live endpoints, trimmed only where a line wrapped: `quote`
above the rule, then `route` moments later. The on-chain figure differs between
them because the pool moved in the seconds between the two commands, which is
the reason a plan carries a snapshot hash and expires in sixty seconds.

The `±` is the uncertainty the model derives for itself. A maker estimate that
may or may not fill carries far more of it than a taker order that will.

## The problem

An AI agent places a market order and pays the spread, the commission and the
impact. Those three are routinely larger than the edge the strategy was chasing.
Almost nothing measures them, and nothing chooses between venues per order.

Binance Agent OS already gives an agent two ways to buy the same asset: the
exchange, and on-chain through the Agentic Wallet. They do not cost the same, and
which one is cheaper changes with the size of the order.

## What it does

For any order, at one instant:

1. **Prices both venues.** Binance spot from the live book — commission, half
   spread, and the impact of walking however many levels the size needs.
   On-chain from the pool's own quoter on every fee tier, plus gas at the live
   price and the wallet's service fee.
2. **Picks the cheaper one,** and splits the order across time when a single
   order would move the book past the limit you set.
3. **Gates it.** Seventeen deterministic rules, including six specific to
   execution: impact, slippage, resting depth, snapshot age, venue, and
   disagreement between the two independent on-chain price sources.
4. **Executes and confirms.** The fill is read back from the venue. The response
   that placed the order is never treated as proof it happened.
5. **Issues a receipt** comparing predicted cost to realised cost, and to what
   the other venue would have charged.

## What we found

Measured, not asserted. Regenerate any of it with `npm run evidence`.

<!-- EVIDENCE:BEGIN — generated by `npm run evidence`, do not edit by hand -->

| Pair | Order size | Samples | On-chain cheaper | Median on-chain | Median Binance | Median edge |
|---|---|---|---|---|---|---|
| BNBUSDT | $100 | 44 | 100% | 1.49 bps | 10.07 bps | 8.60 bps |
| BNBUSDT | $1,000 | 44 | 100% | 1.13 bps | 10.07 bps | 8.92 bps |
| BNBUSDT | $10,000 | 44 | 100% | 1.95 bps | 10.07 bps | 8.12 bps |
| BNBUSDT | $100,000 | 44 | 68% | 11.03 bps | 11.76 bps | 0.47 bps |
| BTCUSDT | $100 | 44 | 0% | 51.70 bps | 10.00 bps | -41.70 bps |
| BTCUSDT | $1,000 | 44 | 0% | 53.40 bps | 10.00 bps | -43.40 bps |
| BTCUSDT | $10,000 | 44 | 0% | 56.28 bps | 10.00 bps | -46.28 bps |
| BTCUSDT | $100,000 | 44 | 0% | 65.56 bps | 10.00 bps | -55.54 bps |
| ETHUSDT | $100 | 44 | 100% | 2.15 bps | 10.02 bps | 7.85 bps |
| ETHUSDT | $1,000 | 44 | 100% | 3.02 bps | 10.02 bps | 6.95 bps |
| ETHUSDT | $10,000 | 44 | 43% | 10.85 bps | 10.02 bps | -0.80 bps |
| ETHUSDT | $100,000 | 44 | 0% | 64.35 bps | 10.21 bps | -54.04 bps |
| XRPUSDT | $100 | 44 | 0% | 81.52 bps | 10.17 bps | -71.34 bps |
| XRPUSDT | $1,000 | 44 | 0% | 82.74 bps | 10.20 bps | -72.62 bps |
| XRPUSDT | $10,000 | 44 | 0% | 111.82 bps | 10.22 bps | -101.56 bps |

Measured across 660 samples spanning 7.1 hours. On-chain was cheaper in 41% of them.
<!-- EVIDENCE:END -->

**The cheaper venue changes with size, and the crossover is different for each
pair.** BNB/USDT wins on-chain in every $10,000 sample and still wins two times
in three at $100,000. ETH/USDT has already turned by $10,000, because its pool
is shallower. BTC/USDT and XRP/USDT never win on-chain at any size sampled:
neither BTCB nor XRP is named in the wallet's free fee group, so a 50 bps
service fee lands on the swap and no pool depth can make that back.

Those are four fixed sizes, which is enough to show the flip exists but not
where it is. `crucible crossover` bisects the live cost curves to find it:

```
crucible crossover --symbol BNBUSDT

       $100.00   binance    7.57   on-chain    1.67    on-chain
    $35,355.00   binance    9.62   on-chain    4.77    on-chain
    $88,440.00   binance   10.77   on-chain   10.29    on-chain
    $94,015.00   binance   10.86   on-chain   10.86    Binance spot maker
   $250,000.00   binance   13.41   on-chain   31.32    Binance spot maker

crossover  $93,302 ± 2%
```

Twelve live quotes, pinned to two per cent. Run it three times in an afternoon
and it reads $104k, then $93k, then $90k — which is the point, not a defect: the
flip moves with the book, the pool, the gas price and your own fee tier, so it
is a reading rather than a constant. There is nowhere to look this number up.

Two things it refuses to do. On BTC/USDT it stops after two quotes and reports
no crossover, rather than bisecting a curve that never crosses. And when one
venue cannot price an order at all — the book too thin, the pool too shallow —
the lone answer is not called a winner: the top of the range walks down until
both venues quote, and the range actually used is stated.

That is the entire argument for routing per order rather than picking a venue
once and living with it. A product that had assumed on-chain was cheaper —
which the first two pairs alone would have supported — would be wrong on half
the pairs here, and wrong in the direction that costs money.

The gap comes almost entirely from the commission: 10 bps on Binance spot at
VIP 0 against 1 bps in the deepest BNB/USDT pool, with no wallet fee between two
major assets and gas under a tenth of a basis point. It shrinks on a better fee
tier and it reverses on a large enough order. Full method, component breakdown
and limits: [`docs/EXECUTION_EVIDENCE.md`](docs/EXECUTION_EVIDENCE.md).

## Try it

Node 22 or later. No API key needed — both venues are priced from public
endpoints. The commands call node directly rather than `npm run cli --`,
because Windows PowerShell drops the `--` and npm then eats every flag after
it — `--usd 10` arrives as `10`.

```bash
git clone <this repo> crucible && cd crucible && npm install

node --experimental-strip-types src/cli.ts quote  --symbol BNBUSDT --usd 500        # price every route
node --experimental-strip-types src/cli.ts route  --symbol BNBUSDT --usd 50000      # choose one, and gate it
node --experimental-strip-types src/cli.ts route  --symbol BNBUSDT --usd 2000000    # watch the risk engine refuse
node --experimental-strip-types src/cli.ts crossover --symbol BNBUSDT                # the size where the venue flips
node --experimental-strip-types src/cli.ts policy                                    # what is protecting you
node --experimental-strip-types src/cli.ts samples                                   # the evidence so far
node --experimental-strip-types src/cli.ts calibration                               # how wrong the model has been
```

Two scripts show the parts a terminal transcript hides:

```bash
node --experimental-strip-types demo/attack.ts          # nineteen attacks, run for real
node --experimental-strip-types demo/agent-session.ts   # the same product, driven over MCP
```

`demo/attack.ts` exits non-zero if any of the nineteen attacks succeeds, and CI runs it.

There is also a dashboard, if you would rather see a cost breakdown than read
one:

```bash
npm run dashboard        # landing at http://127.0.0.1:8787, the app at /app
```

It quotes live, shows the component breakdown for both venues side by side, the
rules in force, the recorded evidence, and the ledger with its verification
state. `node:http` and no framework — every endpoint reads the same functions
the CLI and the MCP server read, so the page cannot show a number the product
does not actually produce.

## Connect it to an agent

Locally, over stdio:

```bash
claude mcp add crucible -- node --experimental-strip-types /absolute/path/to/crucible/src/mcp/server.ts
```

Or over HTTP, which is the same nine tools on a URL. The dashboard serves it at
`POST /mcp`:

```bash
npm run dashboard                                   # local: every tool open on 127.0.0.1:8787/mcp
claude mcp add crucible --transport http http://127.0.0.1:8787/mcp
```

To host it, give the instance an operator token. That one variable does three
things: binds every interface instead of loopback, **opens the instance to the
public** — `quote`, `crossover`, `route`, `policy`, `evidence`, `calibration`,
`check_claim`, `verify_ledger` and `status` answer anyone — and requires
`Authorization: Bearer <token>` before `execute` or `reconcile` will act:

```bash
CRUCIBLE_MCP_TOKEN=<long random secret> npm run dashboard
claude mcp add crucible --transport http https://your-host/mcp   # anyone can quote and route; executing needs the token
```

Stateless by design: each request builds a fresh server and tears it down. The
token is compared in constant time. Without a token the server refuses to bind
beyond loopback, so a hosted instance cannot be open by accident.

| Tool | What it does |
|---|---|
| `quote` | Price every route. Decides nothing, sends nothing. |
| `crossover` | The order size where the cheaper venue changes, found by bisecting live quotes |
| `route` | Choose the cheapest, gate it, return a fingerprinted plan |
| `execute` | Execute a plan by id, and confirm the fill |
| `policy` | Which rules are in force |
| `evidence` | The recorded venue comparison |
| `verify_ledger` | Recompute the hash chain and check the signature |
| `calibration` | How wrong the cost model has been against real fills |
| `reconcile` | Resolve an order that was sent but never read back |
| `check_claim` | Check a summary against the ledger before telling the user |
| `status` | Whether each execution path can actually be reached |

`execute` takes **only a plan id**. The plan is the authorisation, so an agent
cannot alter the order between the decision and the fill — any change produces a
different plan, which has to clear the gates again.

A write is a lifecycle, not an event. `execute` records the order the instant a
venue accepts it, before trying to learn what became of it. If the read-back
then fails, the result is **unconfirmed** — a separate error class from a
failure, because the right response is the opposite: a failure can be retried,
an unconfirmed order must not be. Its notional stays held against every cap
until `reconcile` asks the venue and gets an answer. Not knowing is never
treated as knowing it did not happen.

And what the agent *says* is checked too. Every gate above governs what reaches
a venue; `check_claim` governs what reaches you. A summary is held to the
ledger: every figure must be one a record carries at the precision written, a
trade may only be called done when a fill was confirmed, and — the one a
word-by-word check cannot see — a refusal that happened may not be left out.
"I reviewed the market and took no action" is true in every word and false when
five orders were refused. Every refusal returns a correct summary built only
from records. An agent can still not call it; what it cannot do is call it and
lie.

## Built on Agent OS: your real fees, your real equity, the whole tool surface

Commission is ten of the eleven basis points on a typical exchange-side quote,
and it decides the venue on its own. Without a credential Crucible prices at the
public VIP 0 schedule and says so on every report. Most accounts pay less.

Binance Agent OS is the way to fix that without putting an API key on this
machine. Authorise the exchange's own MCP server once from your client:

```bash
claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic
# then open /mcp, select binance-mcp-server, and authenticate on Binance's consent screen
```

From then on every quote, route and dashboard figure is priced at **your
account's rate for that symbol**, read through the session your client
established — `account/commission`, the same figure the exchange charges you.
Verified against the live server: the commission tool is not in the 50 the
server lists, and Crucible reaches it through Binance's `tool_execute`.
`status` shows which source is in use and, when it is the fallback, exactly why.
A server or CI can supply the session as `BINANCE_MCP_TOKEN`; an API key in the
environment is the second source; the public schedule is the last, and is never
presented as anything else.

The session is used only to read here. Orders still go out on the signed execution path.

The same session sizes the risk caps to your **real spot balance** rather than a
placeholder, and `scripts/enumerate-agentos.ts` walks the server's full surface
— the fifty listed tools plus `tool_search` across every category — into
[`docs/agentos-catalogue.json`](docs/agentos-catalogue.json): **221 tools**,
each classified read or write, fail-closed so an unrecognised tool counts as a
write. A first-party capture from this repository's own session, not a
transcription.

## How it is built

**One snapshot, then pure functions.** Both venues are fetched concurrently and
hashed into a single object. Nothing downstream reads a clock or a network, so
the same snapshot always produces the same plan and the same fingerprint. That is
what makes a decision checkable by someone who was not there when it was made.

**Impact and divergence are separated.** The on-chain cost is split using a
near-zero-size reference quote from the same pool. Measuring impact against the
Binance mid would conflate how far the order pushes the pool with how far the
pool had already drifted from the exchange, and only the first is a cost of
trading.

**Fill probability is measured, not guessed.** A resting order clears only once
enough volume has crossed to work through the queue ahead of it plus itself, so
the model reads real trade flow from the tape. A larger order is *less* likely to
fill — the opposite of what a naive queue-ratio model says, and getting it
backwards is how a tool ends up recommending a post because it is big.

**Adverse selection is measured too, and it changes the answer.** A resting order
does not fill at random. It fills when somebody chose to trade into it, and that
somebody is more often right than wrong over the next few seconds — so the fill
is systematically worse than the price that printed.

Crucible measures it from the tape it already fetches: take every trade where a
seller crossed into the bid, compare its price against the volume-weighted price
of everything that traded in the next five seconds, and average over roughly 450
fills. On BNBUSDT that comes to **0.4 to 0.8 bps**. On ETHUSDT up to **1.7**.

Posting at the touch earns the half spread, which is **0.065 bps**.

So passive execution loses money at VIP 0, where the maker and taker rates are
identical. The model said the opposite until this was measured and charged.

**A modelled route does not beat a measured one by a rounding error.** Posting is
priced with the chance of not filling, and the cost of being picked off when it
does. Crucible routinely concludes that posting is not worth it, and says why.

**Risks with no expected cost are named, not priced.** An on-chain swap settles
over several blocks and the pool moves in that window; it can also fail on
slippage and still cost gas. Average drift is zero, so there is no honest number
to charge — but the exchange route does not carry either risk, and a cheaper
number that hides one is not cheaper. They are stated next to the price.

**Refusals are recorded.** Every decision, allowed or blocked, is appended to a
hash-chained ledger and the head is signed. A ledger that only holds successes is
a marketing document.

## Safety

- **Two switches for live execution.** The policy must say `live` *and*
  `CRUCIBLE_LIVE=1` must be set in the shell. A config file an agent could edit
  is not on its own enough to move real money.
- **No private keys.** The on-chain leg runs through the Agentic Wallet CLI,
  which holds its own key and enforces its own daily limit and token scope. This
  process can only ask.
- **Unknown config keys are refused,** not ignored. A misspelling that silently
  disables a limit is exactly the failure this exists to prevent.
- **Risk-reducing orders keep their exemptions.** A cap that blocks the order
  closing a losing position traps you in the trade you wanted out of.

## Tests

```bash
npm test
```

412 tests, no network required — every one builds its fixtures inline or injects
a fake transport, so a green run means the code is good rather than that the
exchange was up.

Tests are checked the same way the product is: by breaking the thing they cover
and confirming they notice. The ledger was mutation-tested against seven ways of
breaking it and caught all seven; the risk engine against seven more; the venue
layer against six, including flipping the sign on adverse selection and dropping
the decimals scaling on the on-chain quoter. Reversing the wallet swap's
direction fails four tests, and giving `execute` an order field alongside its
plan id fails the test that exists to stop exactly that.

Concurrent appends were checked for real: four processes writing at once keep the
chain intact, and removing the lock breaks it at record five — so the lock is
load-bearing, not decoration.

## Honest limits

Stated here rather than in a footnote, because a tool that measures small numbers
has no business being vague about its own error.

- **Maker cost is an estimate.** It is weighted by a fill probability derived
  from measured flow, and the receipt's predicted-versus-realised error is the
  check on whether that model is any good.
- **Fourteen real fills, and they only test part of the model.** Every order was
  routed, gated, sent to Binance, read back and receipted. Since the commission
  reading was corrected, thirteen fills have a mean error of **+0.09 bps** and
  twelve of them are exact. That is a weaker result than it looks: these were
  small orders on a deep book, where impact is zero and the estimate is almost
  entirely the commission — a figure now read from the account rather than
  guessed. The impact and maker terms have never been graded, because no order
  large enough to move the book has been executed. The one miss, +1.18 bps, was
  the price moving between the quote and the fill, which is what the `±` is for.
- **Demo Mode, not mainnet.** Demo Mode is the real matching engine on a
  practice account. No order has been sent to the live exchange, and no
  on-chain swap has been executed at all — that needs a signed-in wallet, so
  the entire on-chain half of the router is unproven in execution.
- **The evidence span is short.** It shows the shape of the cost curve and where
  the crossover sits. It does not describe a full market cycle. Rows priced
  under an earlier cost model are excluded rather than averaged in, which is
  correct and makes the usable span shorter than the file.
- **Four pairs.** Two where on-chain wins at small size and two where it never
  wins. A thinner pair, or one whose pool is on another chain, would look
  different again.
- **Fees default to the public VIP 0 schedule** when no account credential is
  present, and every report says so. A real account usually pays less, which
  narrows the gap this product reports.
- **A quote is not a fill.** On-chain swaps can fail on slippage or liquidity;
  maker orders can fail to fill. Both are reported as what they are.
- **One operator, one policy.** Not multi-tenant.

Crucible makes the trade you already decided on cost less. It does not know
whether you should be making it.

## Licence

MIT. Not financial advice — you are responsible for the trades your agent places.
