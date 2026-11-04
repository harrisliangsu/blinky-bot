# Mac package

`productName` is BlinkyBot. `appId` is `bot.blinky.shell`. electron-builder writes both into the `.app`. The Sparkle public key is `Scripts/sparkle-public-key.txt` and is also `SUPublicEDKey` in `package.json`.

On a Mac:

```bash
npm ci
./Scripts/package-mac.sh
./Scripts/open-smoke.sh
```

| Script | Result |
| --- | --- |
| `package-mac.sh` | `release/mac-arm64/BlinkyBot.app` (or `release/mac/` on Intel), plus the dmg and zip |
| `dmg.sh --reuse` | `release/BlinkyBot-<version>.dmg` from the unpacked app |
| `zip-app.sh` | `release/BlinkyBot-<version>.zip` for the Sparkle feed |
| `open-smoke.sh` | Launches that app and waits until the window is ready |

`dmg.sh` without `--reuse` builds the unpacked app first. The release workflow always reuses one build so the disk image and the zip match.

The private Sparkle key is the Actions secret `SPARKLE_PRIVATE_KEY`. Do not put it in the repository and do not rotate it.

`Scripts/release-notes.py` and `Scripts/appcast.py` run on Linux. See [docs/releasing.md](../docs/releasing.md).
