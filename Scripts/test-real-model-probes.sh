#!/usr/bin/env bash
# Real-model semantic probes. These talk to the user's actual CLI identities
# and cost a small amount of quota; they never touch real app data (each run
# uses a fresh isolated evidence directory under the system temp folder).
#
#   ./Scripts/test-real-model-probes.sh           # both probes
#   ./Scripts/test-real-model-probes.sh planning  # codex planning semantics only
#   ./Scripts/test-real-model-probes.sh kimi      # kimi ACP probe only (BLINKY_KIMI_MODEL to pick a model)
#   ./Scripts/test-real-model-probes.sh loop      # completion-loop semantics only
#   ./Scripts/test-real-model-probes.sh bench-plan-gate  # plan-gate A/B benchmark (two runs)
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
run_plan_gate_bench() {
  local off on
  off="$(mktemp -d "${TMPDIR:-/tmp}/blinky-plangate-off.XXXXXX")"
  on="$(mktemp -d "${TMPDIR:-/tmp}/blinky-plangate-on.XXXXXX")"
  echo "[bench] plan gate OFF -> $off"
  BLINKY_PLANGATE_MODEL_ROOT="$off" node --experimental-transform-types --import ./scripts/register-ts.mjs Scripts/test-plan-gate-benchmark.mjs --gate-off || return 1
  echo "[bench] plan gate ON -> $on"
  BLINKY_PLANGATE_MODEL_ROOT="$on" node --experimental-transform-types --import ./scripts/register-ts.mjs Scripts/test-plan-gate-benchmark.mjs || return 1
  echo "[bench] compare metrics.json under each root"
}
run_loop() {
  # The loop probe creates its own evidence root and requires it to be absent.
  local root
  root="$(mktemp -d "${TMPDIR:-/tmp}/blinky-loop-probe.XXXXXX")/evidence"
  echo "[probe] codex completion-loop semantics -> $root"
  BLINKY_LOOP_MODEL_ROOT="$root" node --experimental-transform-types --import ./scripts/register-ts.mjs Scripts/test-task-loop-real-model.mjs
}
status=0
case "$which" in
  planning) run_planning || status=1 ;;
  kimi) run_kimi || status=1 ;;
  loop) run_loop || status=1 ;;
  bench-plan-gate) run_plan_gate_bench || status=1 ;;
  both) run_planning || status=1; run_kimi || status=1; run_loop || status=1 ;;
  *) echo "Unknown probe: $which" >&2; exit 2 ;;
esac
exit $status
