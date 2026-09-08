# Crucible tools

Ten tools, over stdio or HTTP. Sizes are given as either `usd` (in the quote
asset) or `baseQty` (in the base asset), never both.

| Tool | Arguments | Changes state? | What comes back |
|---|---|---|---|
| `quote` | `symbol`, `side` (BUY/SELL), `usd` or `baseQty` | No | Every route priced at one instant: Binance spot taker, Binance spot maker, on-chain taker. Each with its cost components in basis points, an uncertainty bar, and notes. Which is cheapest and by how much. Whether fees are the account's real rate or the public schedule. |
| `route` | `symbol`, `side`, `usd` or `baseQty`, optional `equityUsd` | No (records the decision) | The chosen route and why, every rejected route, every policy rule's verdict with its numbers, a plan id and fingerprint, and the plan's expiry (60 s). ALLOW, BLOCK, HOLD or ALLOW_CAPPED. |
| `execute` | `planId` only | **Yes** | The confirmed fill, read back from the venue: quantity, price, fees per asset, reference (order id or transaction hash). The receipt: predicted vs realised cost in bps, the error, and the saving against the next best route. Or a refusal with the reason. Or **unconfirmed**: the order was sent and its outcome could not be established — do not retry; reconcile. |
| `reconcile` | `planId` | Yes (records the answer) | Asks the venue what became of an unconfirmed order: filled, partly filled, never filled, or still open. Releases the hold on the caps once answered. |
| `check_claim` | `text`, optional `sinceMinutes` | No | Whether a summary is supported by the ledger. Refuses ungrounded figures, execution claims without a confirmed fill, unresolved orders described as done, omitted refusals, forecasts and advice. Always returns a correct summary built from records. |
| `policy` | — | No | Every rule in force, its limit, and the mode. Says plainly that the agent cannot change it. |
| `evidence` | — | No | The recorded venue comparison: per pair and size, how often on-chain was cheaper and by how much, over how many samples. |
| `calibration` | — | No | How wrong the cost model has been against real fills: signed mean, median, worst miss, per venue. With no executions it says the model has never been graded. |
| `verify_ledger` | — | No | Recomputes the hash chain over every decision and checks the signature; names the record where it breaks, if it does. |
| `status` | — | No | Whether each execution path can actually be reached: exchange credentials, wallet session, which commission source is in use, ledger state, execution enabled or not, any unresolved orders. |

## The one property everything rests on

`execute` takes only a plan id. The plan — symbol, side, size, venue, the
snapshot it was priced on, the policy it cleared — is the authorisation. An
agent cannot route a small order, be allowed, and then execute a large one:
any change produces a different plan, which has to clear the gates again.

## Reading a quote

Costs are in basis points of notional (1 bp = 0.01%). A typical exchange-side
taker quote at the public schedule is about 10 bps commission plus a fraction
of a basis point of spread and impact. A typical on-chain quote on a deep pool
is about 1 bp pool fee plus impact, gas and, on some pairs, a 50 bp wallet
service fee. The `±` is the model's own uncertainty; a maker estimate carries
far more of it than a taker order.

## What the errors mean

- **RouteError: No route can fill this order.** Every venue refused to price
  it, each with its reason — usually the size is past what the visible book or
  pool can honestly price.
- **Refused by policy.** The rule and its numbers are named. This is the
  operator's limit, not a suggestion.
- **Unconfirmed.** Sent, outcome unknown, notional held. Reconcile.
- **Read-only.** On a public HTTP instance, `execute` and `reconcile` need the
  operator's token.
