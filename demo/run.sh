#!/usr/bin/env bash
#
# Crucible demo walkthrough.
#
# Runs the real product against live endpoints, in the order that tells the
# story. Nothing here is staged: every price is fetched when the command runs,
# so the numbers will differ from any previous recording. That is the point.
#
#   bash demo/run.sh          # pause between beats, for reading
#   bash demo/run.sh --auto   # 4s pauses, hands-free for screen recording

set -euo pipefail
cd "$(dirname "$0")/.."

AUTO=${1:-}
CLI="node --experimental-strip-types src/cli.ts"

beat() {
  echo
  echo "────────────────────────────────────────────────────────────────────────"
  echo "  $1"
  echo "────────────────────────────────────────────────────────────────────────"
  if [ "$AUTO" = "--auto" ]; then sleep 4; else read -rp "  ↵ " _; fi
}

run() {
  echo
  echo "  \$ crucible $*"
  # Type stripping is still experimental in Node 22; the warning is noise here.
  $CLI "$@" 2>&1 | grep -v "ExperimentalWarning" | grep -v "trace-warnings" || true
}

clear
cat <<'BANNER'

   ██████ ██████  ██    ██  ██████ ██ ██████  ██      ███████
  ██      ██   ██ ██    ██ ██      ██ ██   ██ ██      ██
  ██      ██████  ██    ██ ██      ██ ██████  ██      █████
  ██      ██   ██ ██    ██ ██      ██ ██   ██ ██      ██
   ██████ ██   ██  ██████   ██████ ██ ██████  ███████ ███████

  Your agent decides what to trade.
  Crucible decides where and how, and proves what it cost.

BANNER

beat "1. What can actually execute right now? No pretending."
run status

beat "2. A \$500 buy. Both venues priced at the same instant."
run quote --symbol BNBUSDT --usd 500

beat "3. Same pair, \$100,000. The answer changes."
run quote --symbol BNBUSDT --usd 100000

beat "4. So it routes per order. \$50,000, chosen and gated."
run route --symbol BNBUSDT --usd 50000

beat "5. Now an order that should not happen. \$2,000,000."
run route --symbol BNBUSDT --usd 2000000

beat "6. This is not one lucky reading. It has been measured."
run samples

beat "7. Which rules are in force."
run policy

beat "8. Have the estimates ever been checked against a real fill?"
run calibration

beat "9. Seventeen ways to get money out of this. Every one of them worked once."
node --experimental-strip-types demo/attack.ts 2>&1 | grep -v "Warning" | grep -v "trace-warnings"

beat "10. What the agent tells you is checked against the ledger too."
run claim --text "Bought \$1,000 of BNB and saved 8 bps"

beat "11. And the caller this was built for is not a shell."
node --experimental-strip-types demo/agent-session.ts 2>&1 | grep -v "Warning" | grep -v "trace-warnings"

echo
echo "  Every price above was fetched live when the command ran."
echo "  Nothing was transmitted: execution is off unless two switches agree."
echo
