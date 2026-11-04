#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Launch the built Electron app and wait until it has written the settings
# screenshots. The app itself does the capture when BLINKY_SHOTS=1.
#
#   npm run build
#   ./Scripts/capture-shots.sh

set -euo pipefail

cd "$(dirname "$0")/.."

SHOTS="${BLINKY_SHOTS_DIR:-$PWD/shots}"
DATA="${BLINKY_SMOKE_DIR:-$SHOTS/data}"
rm -rf "$SHOTS"
mkdir -p "$DATA"

export BLINKY_SHOTS=1
export BLINKY_SHOTS_DIR="$SHOTS"
export BLINKY_SMOKE=1
export BLINKY_SMOKE_DIR="$DATA"
export OPENBOT_DATA_DIR="$DATA"

LOG="$SHOTS/electron.log"
./node_modules/.bin/electron --no-sandbox . >"$LOG" 2>&1 &
pid=$!

cleanup() {
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

deadline=$((SECONDS + 240))
while (( SECONDS < deadline )); do
  if [[ -f "$SHOTS/failed" ]]; then
    echo "BlinkyBot screenshot capture failed." >&2
    cat "$SHOTS/failed" >&2 || true
    echo "----- electron.log -----" >&2
    cat "$LOG" >&2 || true
    exit 1
  fi
  if [[ -f "$SHOTS/done" ]]; then
    break
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "Electron exited before the screenshots were written." >&2
    cat "$LOG" >&2 || true
    exit 1
  fi
  sleep 1
done

if [[ ! -f "$SHOTS/done" ]]; then
  echo "Timed out waiting for screenshots." >&2
  cat "$LOG" >&2 || true
  exit 1
fi

missing=0
expect=(
  main-light.png
  main-dark.png
  chat-no-backend-light.png
  chat-no-backend-dark.png
)
for section in general bots profile notifications permissions backends apps updates about; do
  expect+=("settings-light-${section}.png" "settings-dark-${section}.png")
done
for file in "${expect[@]}"; do
  if [[ ! -s "$SHOTS/$file" ]]; then
    echo "missing $file" >&2
    missing=1
  fi
done
if ! grep -q "设置 → 供应商" "$SHOTS/chat-no-backend.txt"; then
  echo "the chat did not show the 设置 → 供应商 message" >&2
  cat "$SHOTS/chat-no-backend.txt" >&2 || true
  missing=1
fi
if grep -q "ENOENT" "$SHOTS/chat-no-backend.txt"; then
  echo "the chat still contains a raw ENOENT" >&2
  cat "$SHOTS/chat-no-backend.txt" >&2 || true
  missing=1
fi
exit "$missing"
