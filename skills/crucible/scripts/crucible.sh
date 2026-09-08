#!/usr/bin/env bash
#
# Crucible from a shell, for runners that do not speak MCP.
#
# Every subcommand calls the same code the MCP tools call. Nothing here is a
# second path, and nothing here prints a secret: keys and tokens are read from
# the environment and passed through.
#
#   bash crucible.sh status
#   bash crucible.sh quote  BNBUSDT 500          # $500, BUY by default
#   bash crucible.sh quote  BNBUSDT 500 SELL
#   bash crucible.sh route  BNBUSDT 500
#   bash crucible.sh claim  "Bought 0.66 BNB and saved 8 bps"
#   bash crucible.sh mcp    tools/list           # JSON-RPC to a running HTTP instance
#   bash crucible.sh mcp    tools/call '{"name":"policy","arguments":{}}'
#
# Environment:
#   CRUCIBLE_DIR        the checkout; defaults to two levels above this script
#   CRUCIBLE_MCP_URL    for `mcp`; defaults to http://127.0.0.1:8787/mcp
#   CRUCIBLE_MCP_TOKEN  for `mcp`; sent as a bearer when set

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="${CRUCIBLE_DIR:-$(cd "$here/../../.." && pwd)}"
cli="$root/src/cli.ts"

if [ ! -f "$cli" ]; then
  echo "crucible.sh: cannot find src/cli.ts under $root. Set CRUCIBLE_DIR to the checkout." >&2
  exit 2
fi

run_cli() {
  # Type stripping is experimental in Node 22; its warning is noise here.
  node --experimental-strip-types "$cli" "$@" 2> >(grep -v "ExperimentalWarning\|trace-warnings" >&2)
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  status)
    run_cli status "$@"
    ;;
  quote|route)
    symbol="${1:?usage: crucible.sh $cmd SYMBOL USD [BUY|SELL]}"
    usd="${2:?usage: crucible.sh $cmd SYMBOL USD [BUY|SELL]}"
    side="${3:-BUY}"
    run_cli "$cmd" --symbol "$symbol" --usd "$usd" --side "$side"
    ;;
  claim)
    text="${1:?usage: crucible.sh claim \"summary text\"}"
    run_cli claim --text "$text"
    ;;
  policy|evidence|calibration|verify)
    case "$cmd" in
      evidence) run_cli samples ;;
      *) run_cli "$cmd" ;;
    esac
    ;;
  mcp)
    method="${1:?usage: crucible.sh mcp METHOD [PARAMS-JSON]}"
    params="${2:-}"
    url="${CRUCIBLE_MCP_URL:-http://127.0.0.1:8787/mcp}"
    if [ -n "$params" ]; then
      body="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}"
    else
      body="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\"}"
    fi
    auth=()
    if [ -n "${CRUCIBLE_MCP_TOKEN:-}" ]; then auth=(-H "Authorization: Bearer $CRUCIBLE_MCP_TOKEN"); fi
    curl -sS -X POST "$url" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      "${auth[@]}" \
      -d "$body"
    echo
    ;;
  help|--help|-h)
    sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
  *)
    echo "crucible.sh: unknown command '$cmd'. Run: crucible.sh help" >&2
    exit 2
    ;;
esac
