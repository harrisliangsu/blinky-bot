# Changelog

## 0.3.14

- **A packaged app checks the Sparkle feed shortly after launch and again every 12 hours.** When a newer signed zip is available, it posts a notification and shows a dialog to download and install. Later and Skip This Version are on that dialog. Check now, the settings row, and Check for Updates… in the app menu use the same prompt.
- **The zip is verified with the existing Ed25519 key before it replaces the app.** A signature that does not match leaves the installed copy in place.

## 0.3.13

- **The Apps list shows an icon, a name, and Connected or Not connected.** A connected app also shows the account name. An app that is not connected has only Connect, and that opens its page. Reconnect, Disconnect, which Bots may use the app, and Advanced: bring your own client stay on that page. The advanced form stays closed until you open it. Calendar and Slack stay off the list.
- **Tools manages skills, MCP servers, and AGENTS.md.** Built-in tools such as reading a file or running a command stay on by default. They are not listed, and they are not synced. The page opens on Tools. Agent is the view for one Agent. Sync all can copy from one Agent, or merge the union of every Agent. It only adds a skill or an AGENTS.md file that is missing. It does not take an assignment away, and it does not turn off an enabled MCP server. Skills that share a name are grouped, each source is tagged, and the description stays closed.
- **Permissions leads with the macOS grants this app already uses.** Those are Screen Recording, Accessibility, Automation, Microphone, and Notifications. The status is a live check: Granted, Not granted, Not determined, or Unknown. Open System Settings jumps to that pane. Other privacy items can be added. Removing a row only hides it here. It does not revoke the permission in macOS.

## 0.3.12

- **Apps lists GitHub, Gmail, and X.** Calendar and Slack stay in the product and stay off this grid. Git identity is no longer a card here.
- **GitHub signs in with BlinkyBot’s own GitHub App.** Authorization opens in the browser. An earlier `gh auth login` no longer counts as connected. Disconnecting removes only the token BlinkyBot saved, and leaves `gh` and github.com signed in.
- **Gmail and X use official OAuth.** Gmail can search, read, and draft mail. X this wave is posts only: read a post, or publish a text post or reply. Sending mail and publishing a post still wait for a confirmed draft.
- **A GitHub comment or an X post leaves only from its draft card.** The shell refuses a comment posted with `gh` or the GitHub API, so that command cannot replace the card. Other GitHub writes still ask before they run.
- **The packaged app receives its OAuth clients at package time.** Google, X, and GitHub client values come from `MAIN_VITE_*` and are not stored in the repository. When a client is missing, that app says browser sign-in is not enabled and does not start it.
- **A device on the same Wi-Fi can open a workspace you approve.** The Mac sets the scope and whether that device can view or act. Sign-in, credentials, and local approvals stay on the Mac. Revoking the share closes that remote workspace.
- **A running task shows its current step and any blocker.** When a task comes back, the notice names where the deliverable is. New delegated work uses the conversation’s folder. A task that depends on one earlier task reuses that task’s folder. An isolated folder needs a specific reason.
- **A Bot can use a provider’s fast lane.** The switch appears for an OpenRouter model, and for an OpenAI model that accepts priority service. Every other backend hides it. Faster replies cost more.
- **Settings and the chat are quieter.** The models page is labeled Agent and describes these as the runtimes a Bot runs on. A message sent during a run says it is queued, and a paused queue can be resumed. Tools can show which Agents have each tool, and syncing only adds a tool that is missing.
- **Codex finishes a file change with BlinkyBot’s edit tools.** Its own sandbox stays read-only. A refusal there no longer ends the turn by pasting the change into the chat.

## 0.3.9

- **The model picker lists the CLI's real models.** Codex fills the list from `model/list`, so it is no longer only the word default. Claude Code offers the aliases Opus, Sonnet, and Haiku.
- **Paste or drop an image and it reaches the CLI.** The image stays on the message. Codex receives it as a local image file. Claude Code receives it as an image block.

## 0.3.8

- **The chat header keeps only the theme toggle.** The sun or moon switches light and dark and saves that choice. The grid, activity panel, inbox, shared rooms, and settings gear are gone from the header. Those controls stay under Settings → General → Layout. Settings still opens from the sidebar or with Command-comma.
- **The sidebar footer splits Settings, Apps, and More.** The profile menu is Settings, Apps, and More…. Apps keeps GitHub, Git, and Gmail, and Gmail is marked coming soon. Tools is its own page for MCP servers and installed skills.
- **Each Bot can pick a local CLI or a provider, a model, and a thinking depth.** A Bot that still follows the default uses Settings. Unchecking that opens the source, the model, and the thinking depth when that backend can set one.

## 0.3.7

- **The Dock and Finder icon is the Blinky sprout.** The white puppy with a mint sprout sits on a pink-to-purple gradient. 0.3.6 was tagged before that icon landed, so it still showed the black chat bubble.

## 0.3.6

- **Sending a chat no longer waits on a CLI probe.** The reply caret shows up before the CLI starts. A Codex chat stays warm, so the next message skips starting it again. Kimi thinking appears as it arrives, and the answer is not held for it.
- **The main chat hides the working directory, Agent mode, and the model.** Replies do not label which model ran.
- **Add providers and Add CLIs are searchable.** The lists show only what you added, or a CLI that is already installed.
- **Apps connects GitHub, Git, and Gmail for every Bot.** GitHub sign-in opens in Terminal and BlinkyBot does not keep the token. Git edits the global name and email on this Mac. Gmail records that you want it connected.
- **A Bot sends with the CLI it is bound to.** The binding and that CLI’s default model live in Settings. A Bot left on the generic model follows the Settings default CLI.

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
