# Changelog

## 0.2.1

- **Kimi Code and Grok are local CLIs.** Pick them with Claude and Codex. BlinkyBot looks up `kimi` and `grok` on the login-shell PATH, including `~/.kimi-code/bin` and `~/.grok/bin`.
- **Sign-in stays on this Mac.** A missing Kimi or Grok login is shown as needing a key. Grok can also use an xAI API key saved in Settings. A key on the Kimi row does not log the Kimi CLI in.
- **0.2.0 was the packaged app.** That version restored the BlinkyBot disk image on this OpenBOT tree. This build still has no in-app updater, so install the new disk image.

## 0.2.0

- **BlinkyBot packages the OpenBOT desktop.** The Mac app name is BlinkyBot. The source is this OpenBOT tree.
- **Disk image and zip.** The release is `BlinkyBot-0.2.0.dmg` and `BlinkyBot-0.2.0.zip` for Apple Silicon. Docker is not required.
- **Signed update feed.** The zip is signed for BlinkyBot's existing update key. This build has no in-app updater yet, so install the disk image.
- **MIT license.** Source for this version is git tag `v0.2.0`. The license text is `LICENSE`.
