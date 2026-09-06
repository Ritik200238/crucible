# Guardrail

**A policy firewall for Binance Agent OS.** Every order your AI agent proposes is checked against your rules before it can reach Binance. Orders that break a rule are refused, with the reason spelled out in plain language.

Built for the [Binance Agent OS Mini Hackathon](https://www.binance.com/en/blog/community/8802181509900814931), Track A.

```
  GUARDRAIL  dry-run  ·  guardrail.config.json

  BUY 3 BTC  ·  BTCUSDT  ·  USDM_FUTURES  20x
  mark $79,837.18 (live)  →  notional $239,511.51

  ✓ allowed_markets             USDM_FUTURES is an allowed market.
  ✓ symbol_permitted            BTCUSDT is on your allowlist.
  ✗ max_leverage                Requested 20x leverage, your cap is 5x.
  ✗ max_order_notional          Order is $239,511.51, which exceeds your $2,000 per-order cap by $237,511.51.
  ✗ max_position_concentration  BTCUSDT would become 2395.1% of equity, over your 20.0% cap.
  ✓ daily_loss_limit            Down 0.0% today against a 2.0% limit. 2.0% of headroom left.
  ✗ max_daily_notional          This order would put you at $239,511.51 traded today, over your $10,000 daily limit.
  ✓ max_orders_per_hour         0 of 12 orders used in the last hour.
  ✓ no_trade_window             Outside all no-trade windows.
  ! confirm_above_notional      $239,511.51 is at or above your $1,000 threshold. A human needs to approve this one.

   BLOCKED
  Refused by 4 rule(s). Nothing was sent to Binance.
```

## Why

Binance Agent OS ships with real safety work: no withdrawal scope, an isolated Agentic sub-account, confirm-before-execute on every write. The limits it gives you are a daily cap and a token whitelist.

That is the right shape, but it is coarse. It cannot express *"never more than 5x"*, *"stop trading if I'm down 2% today"*, or *"wait 30 minutes after a loss before opening anything new"* — which are the rules that actually keep an account alive when an agent is making decisions faster than you can read them.

Guardrail is that missing layer. It does not replace anything Binance does; it sits in front of it and gets more specific.

## Install

Requires Node 22+.

```bash
git clone https://github.com/<you>/guardrail.git
cd guardrail
npm install
```

## Try it

No Binance account, no API key, no funds needed. Market data comes from Binance's public endpoints, and `mode: "dry-run"` means nothing is ever transmitted.

```bash
# What is protecting me?
npm run cli -- policy

# A sensible order
npm run cli -- check --symbol BTCUSDT --side BUY --quote 40 --equity 10000

# A reckless one
npm run cli -- check --symbol BTCUSDT --market USDM_FUTURES --qty 3 --leverage 20

# An order that needs a human
npm run cli -- check --symbol ETHUSDT --side BUY --quote 1500 --equity 10000

# Trip the circuit breaker, then try to trade again
npm run cli -- record-loss --usd -250
npm run cli -- check --symbol BTCUSDT --side BUY --quote 100 --equity 10000

# But you can always still get out
npm run cli -- check --symbol BTCUSDT --side SELL --quote 100 --equity 10000

# What has it decided so far?
npm run cli -- log
```

`demo/run.sh` walks through all of this in order.

## The rules

Every rule is optional. An absent rule is not enforced, and `guardrail policy` tells you exactly which ones are live — a safety tool that overstates its own coverage is worse than none.

| Rule | What it stops |
|---|---|
| `allowed_markets` | Trading account types you did not mean to enable |
| `symbol_permitted` | Straying outside a known universe of symbols |
| `max_order_notional` | Any single order being too large |
| `max_position_concentration` | One symbol quietly becoming the whole book |
| `max_leverage` | The fastest way to lose an account |
| `daily_loss_limit` | Compounding a bad day. Halts new risk past a threshold |
| `max_daily_notional` | Churn, and the fees that come with it |
| `cooldown_after_loss` | Revenge trading, by enforcing a pause |
| `max_orders_per_hour` | A looping agent, before it reaches your balance |
| `no_trade_window` | Trading through events you chose to sit out |
| `confirm_above_notional` | Large orders slipping through without a human |

Three verdicts: **ALLOW**, **CONFIRM** (passes, but needs a human yes), **BLOCK**.

One BLOCK blocks the order regardless of how many rules passed. Safety rules that can be outvoted are not safety rules.

### Risk-reducing orders are treated differently

A limit that blocks the order closing a losing position is worse than no limit at all — it traps you in exactly the trade you wanted out of. So rules that cap *new* risk skip orders that reduce exposure (`reduceOnly` futures orders, and spot sells), and say so in the log.

You can always get out. That is deliberate, and it is tested.

## Connect it to your agent

Guardrail is an MCP server. Add it to Claude Code:

```bash
claude mcp add guardrail -- npx -y tsx /absolute/path/to/guardrail/src/mcp-server.ts
```

Or run the compiled build:

```bash
npm run build
claude mcp add guardrail -- node /absolute/path/to/guardrail/dist/mcp-server.js
```

Five tools:

| Tool | Purpose |
|---|---|
| `check_order` | Evaluate an order. Call before placing anything. |
| `get_policy` | What rules are in force, and in which mode |
| `get_market_price` | Live Binance price and 24h stats |
| `get_audit_summary` | Every decision made, and how much flow was refused |
| `record_realised_pnl` | Feed closed-trade PnL to the loss limit and cooldown |

Then talk to your agent normally:

> "Check whether buying 3 BTC on 20x futures passes my risk policy."

## Trust model

Being precise about this, because it is the part that is easy to overclaim.

**An MCP tool cannot stop an agent from calling a different MCP server.** If your agent holds the Binance trade scope directly, Guardrail is advice — good advice, reinforced by tool instructions the model sees, but advice.

**Guardrail becomes a real gate when it is the only execution path.** Binance's own scope model makes this achievable. When you authorise the Binance MCP server, grant it market data and account scopes but **not** the trade scope. Give the trading capability to Guardrail instead. Now "check with Guardrail first" is not an instruction the agent could skip — it is the only thing that works.

That layering is the intended deployment. The current release implements the policy engine, the decision surface, and the audit trail; wiring Guardrail's own signed execution path to Binance is the next step, and is not done yet. See below.

## What this does not do yet

Stated plainly, because a risk tool that is vague about its own limits has missed the point.

- **It does not place orders.** There is no signed Binance trading client in this release. Guardrail decides; it does not yet execute. `mode: "live"` and `GUARDRAIL_LIVE=1` are wired through the config and reported honestly everywhere, but no transmission path exists behind them, and `transmitted` is `false` on every audit entry.
- **Account equity and open positions are supplied by the caller,** and are labelled `simulated` throughout. Guardrail holds no exchange credentials, so it cannot read your real balance. Pass `--equity` and `--position`, or have the agent read them from the Binance MCP server and hand them over.
- **Only USD-quoted pairs.** A BTC-quoted pair needs a second conversion hop to reach USD. Rather than under-report risk on every notional rule, Guardrail refuses to evaluate those pairs at all.
- **Loss and cooldown rules depend on being told about closed trades.** Call `record_realised_pnl`. Nothing infers PnL automatically.
- **Not audited, not battle-tested.** It was written for a hackathon in two days. The rule logic is covered by 69 tests, but that is not the same as production use with real money.

## Design notes

**Rules are pure functions.** No I/O, no clock reads, no hidden state — the clock and the account both arrive in the evaluation context. Given the same inputs, a decision is always reproducible, which is what makes the audit log worth trusting.

**Unknown config keys are rejected, not ignored.** A typo like `maxLeverge` that silently disables a limit is exactly the failure this tool exists to prevent, so it fails loudly at load time.

**Live mode needs two independent switches.** `"mode": "live"` in the config *and* `GUARDRAIL_LIVE=1` in the shell. A file an agent could conceivably edit is not enough on its own to move real money.

**Corrupt state fails closed.** An unreadable state file resets every counter to zero, so caps apply in full rather than reading as already-spent.

## Tests

```bash
npm test
```

69 tests. The ones worth reading cover the awkward cases: risk-reducing orders escaping the caps, a no-trade window that crosses midnight, cooldowns surviving a UTC day rollover, and verdict precedence.

## Layout

```
src/
  types.ts            Domain types
  config.ts           Policy loading and validation
  audit.ts            Append-only JSONL decision log
  cli.ts              Terminal interface
  mcp-server.ts       MCP server for agents
  policy/
    rules.ts          The eleven rules, as pure functions
    engine.ts         Validation and verdict reduction
  binance/
    public.ts         Public market data (read-only, no auth)
  state/
    store.ts          Rolling daily and hourly state
```

## Licence

MIT.

**Not financial advice.** You are responsible for the trades your agent places. Guardrail reduces the chance of a bad order reaching the exchange; it does not make a strategy profitable, and it cannot protect you from a rule you did not write.
