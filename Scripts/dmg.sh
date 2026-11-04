#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Builds release/BlinkyBot-<version>.dmg from the unpacked app electron-builder
# wrote: the app, a shortcut to Applications, and a short bilingual Read Me.
#
#   ./Scripts/dmg.sh           → unpack the Mac app, then write the disk image
#   ./Scripts/dmg.sh --reuse   → package the existing BlinkyBot.app
#
# The release workflow builds once:
#
#   ./Scripts/package-mac.sh
#
# which is electron-builder --dir, this script with --reuse, then the zip.
# The image is not notarized. The Read Me says how to allow the first launch.

set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=mac-app.sh
source Scripts/mac-app.sh
require_macos "dmg.sh"

VERSION="$(package_version)"
VOLUME="BlinkyBot"
STAGING="release/dmg-staging"
FINAL="release/BlinkyBot-$VERSION.dmg"

REUSE=0
for arg in "$@"; do
    case "$arg" in
        --reuse) REUSE=1 ;;
        -h|--help)
            echo "Usage: Scripts/dmg.sh [--reuse]"
            exit 0
            ;;
        *)
            echo "Unknown option: $arg" >&2
            exit 1
            ;;
    esac
done

if [[ "$REUSE" -eq 0 ]]; then
    export CSC_IDENTITY_AUTO_DISCOVERY=false
    npm run build
    if ! node -e "require('electron')" >/dev/null 2>&1; then
        node node_modules/electron/install.js
    fi
    npx electron-builder --mac --dir
fi

APP="$(find_blinky_app)"
if [[ ! -x "$APP/Contents/MacOS/BlinkyBot" ]]; then
    echo "No BlinkyBot executable in $APP." >&2
    exit 1
fi
bundled="$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist" | tr -d '[:space:]')"
if [[ "$bundled" != "$VERSION" ]]; then
    echo "$APP is version $bundled; package.json is $VERSION." >&2
    exit 1
fi
echo "Packaging $APP (version $VERSION)."

case "$(uname -m)" in
    arm64)
        ARCH_EN="Apple Silicon (arm64)"
        ARCH_ZH="Apple 芯片（arm64）"
        ;;
    x86_64)
        ARCH_EN="Intel (x86_64)"
        ARCH_ZH="Intel（x86_64）"
        ;;
    *)
        ARCH_EN="$(uname -m)"
        ARCH_ZH="$(uname -m)"
        ;;
esac

echo "Staging the disk image…"
rm -rf "$STAGING" "$FINAL"
mkdir -p "$STAGING"
ditto "$APP" "$STAGING/BlinkyBot.app"
ln -s /Applications "$STAGING/Applications"

cat > "$STAGING/Read Me.txt" <<EOF
BlinkyBot ${VERSION}

Drag BlinkyBot into Applications, then open it.

This build is not notarized. If macOS blocks the first launch, open BlinkyBot, dismiss the warning, then go to System Settings → Privacy & Security → Security → Open Anyway. You only do this once.

BlinkyBot is the Mac package of this OpenBOT desktop app. Requires macOS 14 or newer. This download is for ${ARCH_EN}. Docker is not required.

Source for this version is the git tag v${VERSION} in the BlinkyBot repository. Licensed under the MIT License. The license text is the LICENSE file at that tag.

---

把 BlinkyBot 拖进「应用程序」，然后打开。

这一版没有 Apple 公证。如果系统拦截了第一次打开：先打开 BlinkyBot 并关闭警告，再到「系统设置 → 隐私与安全性 → 安全性 → 仍要打开」。只需一次。

BlinkyBot 是这棵 OpenBOT 桌面应用的 Mac 安装包。需要 macOS 14 或更高版本。这个安装包适用于 ${ARCH_ZH}。不需要 Docker。

这一版的源代码是 BlinkyBot 仓库里的 git tag v${VERSION}。许可协议是 MIT。协议全文是该 tag 上的 LICENSE。
EOF

hdiutil create -srcfolder "$STAGING" -volname "$VOLUME" -fs HFS+ \
    -format UDZO -imagekey zlib-level=9 -ov "$FINAL"

rm -rf "$STAGING"
echo "→ $FINAL"
du -h "$FINAL"
