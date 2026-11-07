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
source Scripts/package-timing.sh

app_only=0
skip_build=0
for arg in "$@"; do
    case "$arg" in
        --app-only) app_only=1 ;;
        --skip-build) skip_build=1 ;;
        -h|--help)
            echo 'Usage: Scripts/package-mac.sh [--app-only] [--skip-build]'
            echo 'Default: build App, DMG and ZIP. --app-only: local replacement App only.'
            echo 'BLINKY_PACKAGE_OUTPUT may select a separate --app-only output directory.'
            exit 0 ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done
if [[ -n "${BLINKY_PACKAGE_OUTPUT:-}" && "$app_only" -ne 1 ]]; then
    echo 'BLINKY_PACKAGE_OUTPUT requires --app-only.' >&2
    exit 1
fi
if [[ "$skip_build" -eq 1 && ! -f out/main/index.js ]]; then
    echo '--skip-build requires an already built and verified out/.' >&2
    exit 1
fi
package_timing_init

export CSC_IDENTITY_AUTO_DISCOVERY=false

if [[ "$skip_build" -eq 0 ]]; then package_step build npm run build; fi
if ! node -e "require('electron')" >/dev/null 2>&1; then
    package_step electron-install node node_modules/electron/install.js
fi
builder_args=(--mac --dir -c.electronDist=node_modules/electron/dist)
if [[ -n "${BLINKY_PACKAGE_OUTPUT:-}" ]]; then
    builder_args+=("-c.directories.output=$BLINKY_PACKAGE_OUTPUT")
fi
package_step app npx --no-install electron-builder "${builder_args[@]}"
if [[ "$app_only" -eq 0 ]]; then
    ./Scripts/dmg.sh --reuse
    package_step zip ./Scripts/zip-app.sh
fi
echo "Timings: $BLINKY_PACKAGE_TIMINGS"
