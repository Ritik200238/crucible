# crucible — skill notes

The skill itself is `SKILL.md`. This file explains the one script it ships and
what the skill needs from the machine it runs on.

## `scripts/crucible.sh`

A thin wrapper for runners that do not speak MCP. It calls the same code the
MCP tools call, so nothing here is a second path.

```bash
bash scripts/crucible.sh status                          # what can execute right now
bash scripts/crucible.sh quote BNBUSDT 500               # price every route for $500
bash scripts/crucible.sh route BNBUSDT 500               # choose, gate, return a plan
bash scripts/crucible.sh claim "Bought 0.66 BNB"        # check a summary against the ledger
bash scripts/crucible.sh mcp tools/list                  # raw JSON-RPC to a running HTTP instance
```

What it does: resolves the Crucible checkout (`CRUCIBLE_DIR`, or the directory
two levels above the script), then runs `node --experimental-strip-types
src/cli.ts` with the arguments mapped onto the CLI's flags. The `mcp`
subcommand posts a JSON-RPC frame to `CRUCIBLE_MCP_URL` (default
`http://127.0.0.1:8787/mcp`) with `curl`, adding `Authorization: Bearer
$CRUCIBLE_MCP_TOKEN` when that variable is set.

Dependencies: Node 22+, `bash`, `curl` (for `mcp` only). No root, no global
installs. It never prints a secret: tokens and keys are read from the
environment and passed through, not echoed.

## What the skill needs

| To | You need |
|---|---|
| Quote and route | Nothing. Both venues are priced from public endpoints. |
| Execute on Binance spot | `BINANCE_API_KEY`, `BINANCE_API_SECRET`, `CRUCIBLE_BINANCE_BASE` (Demo Mode or mainnet), the policy set to `live`, and `CRUCIBLE_LIVE=1`. |
| Execute on-chain | The Binance Agentic Wallet CLI (`baw`) installed and signed in. |
| Your real commission rate | `binance-mcp-server` authorised in your MCP client; Crucible reads the rate through that session. Otherwise the public VIP 0 schedule is used and labelled. |

## Rules

Neutral and factual: this skill promotes no asset, presents nothing as
guaranteed or safe, and contains no wallet address. It routes and executes a
decision the user has already made.
