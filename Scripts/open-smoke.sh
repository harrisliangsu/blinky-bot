#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Opens a packaged BlinkyBot.app and fails unless the first window becomes
# ready and the bundle carries the Sparkle public key.
#
#   ./Scripts/open-smoke.sh
#   ./Scripts/open-smoke.sh release/mac-arm64/BlinkyBot.app

set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=mac-app.sh
source Scripts/mac-app.sh
require_macos "open-smoke.sh"

APP="${1:-}"
if [[ -z "$APP" ]]; then
    APP="$(find_blinky_app)"
fi
if [[ ! -x "$APP/Contents/MacOS/BlinkyBot" ]]; then
    echo "No BlinkyBot executable at $APP" >&2
    exit 1
fi

VERSION="$(package_version)"
KEY="$(tr -d '[:space:]' < Scripts/sparkle-public-key.txt)"
bundled="$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist" | tr -d '[:space:]')"
if [[ "$bundled" != "$VERSION" ]]; then
    echo "$APP is version $bundled; package.json is $VERSION." >&2
    exit 1
fi
public="$(plutil -extract SUPublicEDKey raw "$APP/Contents/Info.plist" | tr -d '[:space:]')"
if [[ "$public" != "$KEY" ]]; then
    echo "SUPublicEDKey is '$public', expected '$KEY'." >&2
    exit 1
fi
feed="$(plutil -extract SUFeedURL raw "$APP/Contents/Info.plist")"
case "$feed" in
    *"/releases/latest/download/appcast.xml") ;;
    *)
        echo "SUFeedURL is '$feed'." >&2
        exit 1
        ;;
esac
identifier="$(plutil -extract CFBundleIdentifier raw "$APP/Contents/Info.plist")"
if [[ "$identifier" != "bot.blinky.shell" ]]; then
    echo "CFBundleIdentifier is '$identifier'." >&2
    exit 1
fi

support="${BLINKY_OPEN_SMOKE_DIR:-$PWD/release/smoke}"
rm -rf "$support"
mkdir -p "$support"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

export BLINKY_SMOKE=1
export BLINKY_SMOKE_DIR="$support"
export OPENBOT_DATA_DIR="$support"

"$APP/Contents/MacOS/BlinkyBot" >"$support/app.out" 2>&1 &
app_pid=$!
cleanup() {
    if kill -0 "$app_pid" 2>/dev/null; then
        kill "$app_pid" 2>/dev/null || true
        sleep 1
        kill -9 "$app_pid" 2>/dev/null || true
    fi
    pkill -P "$app_pid" 2>/dev/null || true
}
trap cleanup EXIT

deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
    if [[ -f "$support/failed" ]]; then
        echo "BlinkyBot reported a failed start." >&2
        cat "$support/failed" >&2 || true
        cat "$support/app.out" >&2 || true
        exit 1
    fi
    if ! kill -0 "$app_pid" 2>/dev/null; then
        echo "BlinkyBot exited before the window was ready." >&2
        cat "$support/app.out" >&2 || true
        exit 1
    fi
    if [[ -f "$support/app.out" ]] && grep -q -E 'startup failed|failed to load renderer' "$support/app.out"; then
        echo "BlinkyBot log reports a failed start." >&2
        cat "$support/app.out" >&2
        exit 1
    fi
    if [[ -f "$support/ready" ]]; then
        echo "BlinkyBot opened and the window was ready."
        exit 0
    fi
    sleep 2
done

echo "BlinkyBot did not become ready within 120s." >&2
cat "$support/app.out" >&2 || true
exit 1
