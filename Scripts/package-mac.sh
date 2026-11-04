#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Host-architecture Mac package used by the release workflow.
#
#   ./Scripts/package-mac.sh
#
# electron-vite build, electron-builder --dir, then BlinkyBot-<version>.dmg
# and BlinkyBot-<version>.zip. Does not publish and does not launch the app.

set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=mac-app.sh
source Scripts/mac-app.sh
require_macos "package-mac.sh"

export CSC_IDENTITY_AUTO_DISCOVERY=false

npm run build
if ! node -e "require('electron')" >/dev/null 2>&1; then
    node node_modules/electron/install.js
fi
npx electron-builder --mac --dir
./Scripts/dmg.sh --reuse
./Scripts/zip-app.sh
