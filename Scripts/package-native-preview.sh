#!/usr/bin/env bash
# Build the SwiftUI Preview with a private bundled coordinator. --stage-only
# leaves an isolated app under the temporary directory for pre-install tests.
set -euo pipefail
cd "$(dirname "$0")/.."
source Scripts/mac-app.sh
require_macos "package-native-preview.sh"

mode="${1:-}"
if [[ -n "$mode" && "$mode" != "--stage-only" ]]; then
    echo 'Usage: package-native-preview.sh [--stage-only]' >&2
    exit 2
fi
version="$(package_version)"
stage="$(mktemp -d "${TMPDIR:-/tmp}/blinky-native-preview.XXXXXX")"
app="$stage/staging/BlinkyBot Preview.app"
runtime="$app/Contents/Frameworks/BlinkyBot Preview Runtime.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$app/Contents/Frameworks"

node Scripts/require-publisher-oauth.mjs
npm run build
swift build -c release --package-path Native
bin_dir="$(swift build -c release --package-path Native --show-bin-path)"
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --dir \
    -c.electronDist=node_modules/electron/dist \
    -c.appId=bot.blinky.shell.preview \
    '-c.productName=BlinkyBot Preview' \
    -c.extraMetadata.blinkyBuildChannel=preview \
    -c.mac.extendInfo.SUEnableAutomaticChecks=false \
    "-c.directories.output=$stage/runtime"
runtime_source="$stage/runtime/mac-$(uname -m)/BlinkyBot Preview.app"
if [[ ! -d "$runtime_source" ]]; then runtime_source="$stage/runtime/mac/BlinkyBot Preview.app"; fi
test -x "$runtime_source/Contents/MacOS/BlinkyBot Preview"
ditto "$runtime_source" "$runtime"
cp "$bin_dir/BlinkyNative" "$app/Contents/MacOS/BlinkyBot Preview"
cp build/icon.icns "$app/Contents/Resources/icon.icns"

python3 - "$app/Contents/Info.plist" "$runtime/Contents/Info.plist" "$version" <<'PY'
import plistlib, sys
parent, child, version = sys.argv[1:]
with open(child, 'rb') as f: info = plistlib.load(f)
info['LSUIElement'] = True
with open(child, 'wb') as f: plistlib.dump(info, f)
info = {
    'CFBundleDevelopmentRegion': 'zh_CN',
    'CFBundleDisplayName': 'BlinkyBot Preview',
    'CFBundleExecutable': 'BlinkyBot Preview',
    'CFBundleIconFile': 'icon.icns',
    'CFBundleIdentifier': 'bot.blinky.native.preview',
    'CFBundleInfoDictionaryVersion': '6.0',
    'CFBundleName': 'BlinkyBot Preview',
    'CFBundlePackageType': 'APPL',
    'CFBundleShortVersionString': version,
    'CFBundleVersion': version,
    'LSMinimumSystemVersion': '26.0',
    'NSHighResolutionCapable': True,
    'NSPrincipalClass': 'NSApplication',
    'BlinkyNativeBundledRuntime': True,
    'NSCameraUsageDescription': 'BlinkyBot only uses the camera when you attach camera input.',
    'NSMicrophoneUsageDescription': 'BlinkyBot only uses the microphone when you use voice input.',
    'NSAppleEventsUsageDescription': 'BlinkyBot controls apps only for actions you request.',
}
with open(parent, 'wb') as f: plistlib.dump(info, f)
PY
codesign --force --deep --sign - "$runtime"
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
printf '%s\n' "$app" > "$stage/app-path.txt"
echo "Native Preview staging app: $app"

if [[ "$mode" == '--stage-only' ]]; then exit 0; fi
ln -s /Applications "$stage/staging/Applications"
mkdir -p release/preview
final="release/preview/BlinkyBot-Preview-$version.dmg"
hdiutil create -srcfolder "$stage/staging" -volname 'BlinkyBot Preview' -fs HFS+ \
    -format UDZO -imagekey zlib-level=9 "$stage/preview.dmg"
mv -f "$stage/preview.dmg" "$final"
echo "→ $final"
