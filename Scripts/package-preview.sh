#!/usr/bin/env bash
# Build a separately installable local preview without touching the release app.
set -euo pipefail
cd "$(dirname "$0")/.."
source Scripts/mac-app.sh
require_macos "package-preview.sh"
source Scripts/package-timing.sh

skip_build=0
for arg in "$@"; do
    case "$arg" in
        --skip-build) skip_build=1 ;;
        -h|--help) echo 'Usage: Scripts/package-preview.sh [--skip-build]'; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done
if [[ "$skip_build" -eq 1 && ! -f out/main/index.js ]]; then
    echo '--skip-build requires an already built and verified out/.' >&2
    exit 1
fi
level="${BLINKY_DMG_ZLIB_LEVEL:-6}"
if [[ ! "$level" =~ ^[1-9]$ ]]; then echo 'BLINKY_DMG_ZLIB_LEVEL must be 1–9.' >&2; exit 1; fi
package_timing_init

export CSC_IDENTITY_AUTO_DISCOVERY=false
version="$(package_version)"
work="$(mktemp -d "${TMPDIR:-/tmp}/blinky-preview-build.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir -p release/preview "$work/staging"
if [[ "$skip_build" -eq 0 ]]; then package_step build npm run build; fi
if ! node -e "require('electron')" >/dev/null 2>&1; then
    package_step electron-install node node_modules/electron/install.js
fi
package_step preview-app npx --no-install electron-builder --mac --dir \
    -c.electronDist=node_modules/electron/dist \
    -c.appId=bot.blinky.shell.preview \
    '-c.productName=BlinkyBot Preview' \
    -c.extraMetadata.blinkyBuildChannel=preview \
    -c.mac.extendInfo.SUEnableAutomaticChecks=false \
    "-c.directories.output=$work/output"
app="$work/output/mac-$(uname -m)/BlinkyBot Preview.app"
if [[ ! -d "$app" ]]; then
    app="$work/output/mac/BlinkyBot Preview.app"
fi
if [[ ! -x "$app/Contents/MacOS/BlinkyBot Preview" ]]; then
    echo "Preview app not found: $app" >&2
    exit 1
fi
# macOS Notification Center requires a signed app, including local previews.
# Ad-hoc signing establishes local bundle identity; it is not notarization.
package_step preview-sign codesign --force --deep --sign - --entitlements build/entitlements.mac.plist "$app"
codesign --verify --deep --strict "$app"
ditto "$app" "$work/staging/BlinkyBot Preview.app"
ln -s /Applications "$work/staging/Applications"
cat > "$work/staging/Read Me.txt" <<'EOF'
BlinkyBot Preview 是本地开发测试版，可与 BlinkyBot 同时运行。
将 BlinkyBot Preview 拖到「应用程序」，不要替换 BlinkyBot。
测试版使用独立数据目录，不会自动复制正式版对话或设置。
CLI 登录及用户授权访问的文件等外部资源仍由两者共享。
此包未经 Apple 公证，首次打开可能需要在「隐私与安全性」中允许。
EOF
final="release/preview/BlinkyBot-Preview-$version.dmg"
package_step preview-dmg hdiutil create -srcfolder "$work/staging" -volname 'BlinkyBot Preview' -fs HFS+ \
    -format UDZO -imagekey "zlib-level=$level" "$work/preview.dmg"
mv -f "$work/preview.dmg" "$final"
echo "→ $final"
echo "Timings: $BLINKY_PACKAGE_TIMINGS"
