#!/usr/bin/env bash
# Real-model semantic probes. These talk to the user's actual CLI identities
# and cost a small amount of quota; they never touch real app data (each run
# uses a fresh isolated evidence directory under the system temp folder).
#
#   ./Scripts/test-real-model-probes.sh           # both probes
#   ./Scripts/test-real-model-probes.sh planning  # codex planning semantics only
#   ./Scripts/test-real-model-probes.sh kimi      # kimi ACP probe only (BLINKY_KIMI_MODEL to pick a model)
#
# Planning probe: needs the codex CLI logged in.
# Kimi probe: needs the kimi CLI logged in; set BLINKY_KIMI_MODEL (e.g.
# kimi-code/k3.1-pro) to target a specific managed model.
set -uo pipefail
cd "$(dirname "$0")/.."
which="${1:-both}"
run_planning() {
  local root
  root="$(mktemp -d "${TMPDIR:-/tmp}/blinky-planning-probe.XXXXXX")"
  echo "[probe] codex semantic planning -> $root"
  BLINKY_PLANNING_MODEL_ROOT="$root" node --experimental-transform-types --import ./scripts/register-ts.mjs Scripts/test-task-planning-real-model.mjs
}
run_kimi() {
  local root
  root="$(mktemp -d "${TMPDIR:-/tmp}/blinky-kimi-probe.XXXXXX")"
  echo "[probe] kimi acp (${BLINKY_KIMI_MODEL:-default model}) -> $root"
  BLINKY_KIMI_PROBE_ROOT="$root" node --experimental-transform-types --import ./scripts/register-ts.mjs Scripts/probe-kimi-planning-acp.mjs
}
status=0
case "$which" in
  planning) run_planning || status=1 ;;
  kimi) run_kimi || status=1 ;;
  both) run_planning || status=1; run_kimi || status=1 ;;
  *) echo "Unknown probe: $which" >&2; exit 2 ;;
esac
exit $status
