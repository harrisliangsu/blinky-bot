#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Zip the unpacked BlinkyBot.app. Sparkle signs these bytes.
#
#   ./Scripts/zip-app.sh
#
# Writes release/BlinkyBot-<version>.zip. Run Scripts/package-mac.sh or
# electron-builder --mac --dir first.

set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=mac-app.sh
source Scripts/mac-app.sh
require_macos "zip-app.sh"

VERSION="$(package_version)"
APP="$(find_blinky_app)"
FINAL="release/BlinkyBot-$VERSION.zip"

if [[ ! -x "$APP/Contents/MacOS/BlinkyBot" ]]; then
    echo "No BlinkyBot executable in $APP." >&2
    exit 1
fi

rm -f "$FINAL"
ditto -c -k --keepParent "$APP" "$FINAL"
echo "→ $FINAL"
du -h "$FINAL"
