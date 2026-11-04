# Changelog

## 0.3.5

- **The sidebar lists bots only.** Projects, routines, and archived chats stay in the product. They no longer sit under More on the main sidebar.
- **A local CLI shows a row when it is installed and signed in, or after you add it.** Add picks from the known CLIs and shows the detected state. Sign in still opens that CLI’s own login. BlinkyBot does not keep the token. Manage keeps the command, key, and recheck off the default row.
- **The empty provider card is short.** It no longer opens with the long OpenRouter note. Add provider is still how a cloud key is saved.

## 0.3.4

- **Each local CLI shows whether it is signed in.** The row says not installed, not signed in, signed in, or unknown. Sign in opens that CLI’s own login in Terminal. BlinkyBot does not keep the token.
- **Providers are added one at a time.** The provider list starts empty. Add provider offers OpenAI, Anthropic, xAI, and OpenRouter. Removing one clears the key saved for it.

## 0.3.3

- **Backends are split into providers and local CLIs.** Settings opens 供应商 (API key and base URL) above 本地 CLI (command and terminal sign-in).
- **The default bot is Blinky.** A seeded bot that is still named Assistant is renamed. A bot you renamed stays as you named it.
- **Status lines follow the settings language.** A missing key or CLI is described in Chinese by default. English says “an OpenAI key”.

## 0.3.2

- **The dated session list is hidden.** Today, Yesterday, and Older no longer appear on the main sidebar.
- **Clicking a bot opens its newest chat.** If that bot has no chat yet, one is created.

## 0.3.1

- **Codex keeps going when the connection blips.** A notice such as "Reconnecting... 2/5" is shown while Codex retries, and the reply still arrives. A real failure shows Codex's own message, including the extra detail.

## 0.3.0

- **Settings has a sidebar.** General, bots, profile, notifications, permissions, backends, MCP, updates, and about. Search filters the list. Labels are Chinese by default and English is one menu away.
- **The controls persist.** Theme, translucent window, language, interface size, accent, send shortcut, bot steps, external links, launch at login, and running in the background are saved on this Mac. Check now reads the Sparkle feed or a GitHub beta.
- **The main window leads with bots.** Projects, routines, and archived chats sit under More. The activity panel stays closed until you open it.

## 0.2.2

- **Default bots use a signed-in CLI.** BlinkyBot searches a GUI-safe PATH, including `/opt/homebrew/bin`, `~/.local/bin`, `~/.kimi-code/bin`, `~/.grok/bin`, npm global bins, and nvm version bins, and points the default bots at an installed, signed-in backend. Codex, Claude Code, Kimi Code, and Grok come before OpenCode, then the other agent CLIs, then an API key.
- **A missing CLI explains itself.** When nothing is signed in, the chat says so and links to Settings → Backends instead of showing `spawn opencode ENOENT`.

## 0.2.1

- **Kimi Code and Grok are local CLIs.** Pick them with Claude and Codex. BlinkyBot looks up `kimi` and `grok` on the login-shell PATH, including `~/.kimi-code/bin` and `~/.grok/bin`.
- **Sign-in stays on this Mac.** A missing Kimi or Grok login is shown as needing a key. Grok can also use an xAI API key saved in Settings. A key on the Kimi row does not log the Kimi CLI in.
- **0.2.0 was the packaged app.** That version restored the BlinkyBot disk image on this OpenBOT tree. This build still has no in-app updater, so install the new disk image.

## 0.2.0

- **BlinkyBot packages the OpenBOT desktop.** The Mac app name is BlinkyBot. The source is this OpenBOT tree.
- **Disk image and zip.** The release is `BlinkyBot-0.2.0.dmg` and `BlinkyBot-0.2.0.zip` for Apple Silicon. Docker is not required.
- **Signed update feed.** The zip is signed for BlinkyBot's existing update key. This build has no in-app updater yet, so install the disk image.
- **MIT license.** Source for this version is git tag `v0.2.0`. The license text is `LICENSE`.
