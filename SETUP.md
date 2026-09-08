# Setup

Quoting works with no credentials at all — both venues are read from public
endpoints. Everything below is only needed to actually execute.

## 1. Quote and route (no setup)

```bash
npm install
npm run cli -- quote --symbol BNBUSDT --usd 500
npm run cli -- status
```

## 2. Collect evidence

The sampler prices both venues every ten minutes and writes the result to
`data/samples.jsonl`. It needs elapsed time rather than effort, so start it
early and leave it running.

```bash
npm run sampler          # runs until stopped
npm run evidence         # regenerate docs/EXECUTION_EVIDENCE.md and the README table
```

## 3. Execute on the exchange

Use Demo Mode first. It has live-like books and the same filters and limits as
the real exchange, and its balance can be reset.

1. Create an API key at `demo.binance.com` → API Management.
2. Set:

```bash
export BINANCE_API_KEY=...
export BINANCE_API_SECRET=...
export CRUCIBLE_BINANCE_BASE=https://demo-api.binance.com
```

For the live exchange, use `https://api.binance.com` and a mainnet key instead.

## 4. Execute on-chain

The wallet holds its own key. This project never sees one.

```bash
npm i -g @binance/agentic-wallet
baw auth signin --json          # shows a pairing code and a link
                                 # confirm in the Binance app
baw auth verify --qrCodeId <id from signin> --json
baw wallet settings --json      # check the daily limit
```

Set the daily limit low in the Binance app before trading. On-chain execution
is real BNB Smart Chain — there is no test network for this wallet.

## 5. Turn execution on

Two switches, deliberately. Both have to agree.

```bash
cp crucible.config.example.json crucible.config.json
# edit it: "mode": "live"
export CRUCIBLE_LIVE=1
```

`npm run cli -- status` will confirm what is actually reachable.

## 6. Connect an agent

```bash
claude mcp add crucible -- node --experimental-strip-types "$(pwd)/src/mcp/server.ts"
```

## Dashboard

```bash
npm run dashboard        # http://127.0.0.1:8787
```
