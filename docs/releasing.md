# Releasing BlinkyBot

Pushing a `v*` tag builds the Mac app and publishes a GitHub Release. The app id is `bot.blinky.shell`. The product name is BlinkyBot. Source is this OpenBOT tree. The license is MIT.

中文：先把版本改动合并进 `main`，再给这个提交打 tag。不要直接 push `main`。私钥不要换。

## Cut v0.3.0

`package.json` is `0.3.0`. There is no separate `VERSION` file; electron-builder reads `package.json`. Both changelogs have `## 0.3.0`: the settings sidebar, and a main window that leads with bots.

After this change is on `main`:

```bash
git checkout main
git pull origin main
node -p "require('./package.json').version"   # 0.3.0
git tag v0.3.0
git push origin v0.3.0
```

Tag the merge commit on `main`, not the pull request branch. Then merge the `appcast-v0.3.0` pull request the workflow opens.

中文：合并后再打 `v0.3.0`。这一版是设置侧边栏。0.2.2 让默认 Bot 使用已登录的 CLI。

## v0.2.2, v0.2.1 and v0.2.0

`v0.2.2` points default bots at a signed-in CLI. Do not push `v0.2.2` until that pull request is on `main`.

## v0.2.1 and v0.2.0 (already published)

`v0.2.1` added Kimi Code and Grok. `v0.2.0` restored the BlinkyBot disk image on this OpenBOT tree. Do not push those tags again.

The workflow refuses a tag when it does not match `package.json` `"version"`, or when `CHANGELOG.md` / `CHANGELOG.zh-CN.md` has no `##` section for that version.

Watch it:

```bash
gh run list --workflow release.yml --limit 2
gh release view v0.3.0 --json assets --jq '.assets[].name'
```

A finished run has `BlinkyBot-0.3.0.dmg` and `BlinkyBot-0.3.0.zip`. It also uploads `appcast.xml`, `appcast-zh.xml`, and `appcast-en.xml` onto that release and opens a pull request `appcast-v0.3.0`. Merge that pull request. The workflow does not push to `main` and does not merge the pull request.

Actions can open that pull request only when **Settings → Actions → General → Workflow permissions** includes **Allow GitHub Actions to create and approve pull requests**. Without that checkbox, `gh pr create` is rejected. The release stays green: the disk image is already published, and the log warns that a person has to open the pull request from the pushed branch. v0.2.0 hit this; the branch was `appcast-v0.2.0`.

中文：仓库 **Settings → Actions → General → Workflow permissions** 里要勾选 **Allow GitHub Actions to create and approve pull requests**，Actions 才能替 Sparkle 更新源开 Pull Request。没勾时发布不会变红，磁盘映像已经传上去了，需要人手用推上去的 `appcast-v*` 分支开 Pull Request 并合并。

Install `BlinkyBot-0.3.0.dmg`. The build is not notarized. If macOS blocks the first launch, open BlinkyBot, dismiss the warning, then use **System Settings → Privacy & Security → Security → Open Anyway**.

`SPARKLE_PRIVATE_KEY` is already an Actions secret. It must stay the base64 Ed25519 seed for `Scripts/sparkle-public-key.txt` (`M/xUmNfKp+sEloy822L8X4lVdOLM1pv9srD7fw/bgb8=`). Do not rotate it. The private key is not a file in the repository.

## The next version

```bash
# Bump package.json "version" (electron-builder writes it into the app).
# Add the same ## x.y.z section to CHANGELOG.md and CHANGELOG.zh-CN.md.
git add package.json package-lock.json CHANGELOG.md CHANGELOG.zh-CN.md
git commit -m "BlinkyBot x.y.z"
# Open a pull request to main. Merge it. Then:
git tag vx.y.z
git push origin vx.y.z
```

A version with a hyphen, such as `0.3.0-beta.1`, is published as a GitHub pre-release and is not written into the Sparkle feed.

## What the tag runs

`.github/workflows/release.yml` starts on `v*` and on a manual run that names an existing tag.

| Job | Runner | Result |
| --- | --- | --- |
| `mac-app` | `macos-15` (Apple Silicon) | `BlinkyBot-<version>.dmg` and `BlinkyBot-<version>.zip` |

On the runner:

```bash
./Scripts/package-mac.sh
./Scripts/open-smoke.sh
```

`package-mac.sh` is `electron-vite build`, then `electron-builder --mac --dir` for the host architecture, then `Scripts/dmg.sh --reuse` and `Scripts/zip-app.sh`. The disk image adds an Applications alias and a bilingual Read Me. The zip is that same `.app`; Sparkle signs the zip.

`open-smoke.sh` runs before anything is uploaded. It checks `CFBundleShortVersionString`, `SUPublicEDKey`, `SUFeedURL`, and `CFBundleIdentifier`, then launches the executable with `BLINKY_SMOKE=1` and waits until the first window is ready. The smoke log is kept as the `blinky-smoke` artifact.

To build the same artifacts on a Mac without publishing:

```bash
npm ci
./Scripts/package-mac.sh
./Scripts/open-smoke.sh
```

Checks that do not need a Mac:

```bash
python3 Scripts/release_test.py
python3 Scripts/appcast_test.py
```

## Updates

`SUPublicEDKey` in the packaged Info.plist is `Scripts/sparkle-public-key.txt`. `SUFeedURL` is `https://github.com/harrisliangsu/blinky-bot/releases/latest/download/appcast.xml`. The same public key is also copied to `Contents/Resources/sparkle-public-key.txt`.

This Electron build does not embed Sparkle.framework, so the app does not check for updates by itself yet. The signed feed is still published, which is what a later updater build will read. Until then, install the disk image.

The release signs the zip with Sparkle `sign_update` 2.9.6 and `SPARKLE_PRIVATE_KEY`, uploads the three appcast files onto the GitHub Release, and opens a pull request so `main` gets the same files.

## Not in this version

**Notarization and Developer ID.** `electron-builder` is configured with `"identity": null`, so the app is unsigned. A certificate and notarization would remove the first-launch bypass.

**In-app updater.** The feed and the public key are wired. The framework that would install the zip is not in this build.

**Intel on GitHub.** The hosted runner is Apple Silicon. `Scripts/package-mac.sh` packages the architecture of the machine it runs on. `npm run dist` still asks electron-builder for arm64 and x64 disk images, without the release Read Me or the stable `BlinkyBot-<version>` file names.
