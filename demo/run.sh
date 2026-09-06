#!/usr/bin/env bash
#
# Guardrail demo walkthrough.
#
# Runs the full story in order, pausing between beats so it can be screen
# recorded. Every price shown is live from Binance; nothing is ever transmitted.
#
#   bash demo/run.sh          # pause for a keypress between beats
#   bash demo/run.sh --auto   # 3s pauses, hands-free for recording

set -euo pipefail
cd "$(dirname "$0")/.."

AUTO=${1:-}
G="node --experimental-strip-types src/cli.ts"

beat() {
  echo
  echo "────────────────────────────────────────────────────────────────"
  echo "  $1"
  echo "────────────────────────────────────────────────────────────────"
  if [ "$AUTO" = "--auto" ]; then sleep 3; else read -rp "  ↵ " _; fi
}

run() {
  echo
  echo "  \$ guardrail $*"
  # Type stripping is experimental in Node 22; the warning is noise for a demo.
  $G "$@" 2>&1 | grep -v "ExperimentalWarning" | grep -v "trace-warnings" || true
}

clear
cat <<'BANNER'

   ██████  ██    ██  █████  ██████  ██████  ██████   █████  ██ ██
  ██       ██    ██ ██   ██ ██   ██ ██   ██ ██   ██ ██   ██ ██ ██
  ██   ███ ██    ██ ███████ ██████  ██   ██ ██████  ███████ ██ ██
  ██    ██ ██    ██ ██   ██ ██   ██ ██   ██ ██   ██ ██   ██ ██ ██
   ██████   ██████  ██   ██ ██   ██ ██████  ██   ██ ██   ██ ██ ███████

  A policy firewall for Binance Agent OS.
  Your agent proposes. Your rules decide.

BANNER

# Start from a clean slate so the demo is reproducible.
$G reset >/dev/null 2>&1 || true
rm -f .guardrail/audit.jsonl

beat "1. What is protecting me?"
run policy

beat "2. Live market data, straight from Binance"
run price --symbol BTCUSDT

beat "3. A sensible order. Small, spot, well inside every limit."
run check --symbol BTCUSDT --side BUY --quote 40 --equity 10000

beat "4. Now the one that would hurt. 3 BTC on 20x leverage."
run check --symbol BTCUSDT --market USDM_FUTURES --qty 3 --leverage 20 --equity 10000

beat "5. Not everything is a refusal. Big but legitimate escalates to a human."
run check --symbol ETHUSDT --side BUY --quote 1500 --equity 10000

beat "6. Concentration. You already hold \$1,900 of BTC on \$10k equity."
run check --symbol BTCUSDT --side BUY --quote 200 --equity 10000 --position BTCUSDT:1900

beat "7. The day goes wrong. Record a \$250 realised loss."
run record-loss --usd -250

beat "8. The agent wants straight back in. Two rules now say no."
run check --symbol BTCUSDT --side BUY --quote 100 --equity 10000

beat "9. But you can ALWAYS get out. Closing orders are never blocked."
run check --symbol BTCUSDT --side SELL --quote 100 --equity 10000

beat "10. An unlisted symbol never gets near the exchange."
run check --symbol DOGEUSDT --side BUY --quote 50 --equity 10000

beat "11. Everything above is on the record."
run log

echo
echo "  Every decision above was made against live Binance prices."
echo "  Guardrail is in dry-run: not one order left this machine."
echo
