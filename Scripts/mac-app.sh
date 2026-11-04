#!/usr/bin/env bash
# Shared helpers for the Mac package scripts. Source this after cd to the repo root.

if [[ -z "${ROOT:-}" ]]; then
    ROOT="$(pwd)"
fi

find_blinky_app() {
    local candidate
    for candidate in \
        "release/mac-arm64/BlinkyBot.app" \
        "release/mac/BlinkyBot.app" \
        "release/mac-universal/BlinkyBot.app"
    do
        if [[ -d "$candidate" ]]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    echo "No BlinkyBot.app under release/. Run ./Scripts/package-mac.sh first." >&2
    return 1
}

package_version() {
    node -p "require('./package.json').version"
}

require_macos() {
    if [[ "$(uname -s)" != "Darwin" ]]; then
        echo "$1 has to run on macOS. This machine is $(uname -s)." >&2
        exit 1
    fi
}
