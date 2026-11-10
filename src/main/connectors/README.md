# App connections

BlinkyBot uses the system browser for supported OAuth consent. It does not embed provider login pages, copy browser cookies, reuse another application's client identity, or ship user tokens.

| Service | Connection | Distribution prerequisite |
| --- | --- | --- |
| GitHub | BlinkyBot GitHub App user OAuth with PKCE and a fixed loopback callback | Publisher-owned GitHub App client ID and the token-endpoint secret GitHub requires; the user completes browser consent |
| Gmail / Calendar | Desktop OAuth with PKCE and a temporary loopback callback; separate service consent | Publisher-owned Google Desktop client, enabled APIs, consent screen and applicable verification |
| X | Native public-client PKCE | Publisher-owned Native client and applicable API access |
| Slack | Public desktop PKCE for a selected workspace/channel; existing Socket Mode remains compatible | Publisher-owned public client/distribution settings; workspace approval where required |

See [publisher registration](registration/README.md) for exact callbacks, scopes and build configuration. The current candidate has no production Google/X/Slack/GitHub publisher client configuration. Ordinary users should not have to register developer applications; missing publisher configuration is shown honestly, with a separate advanced option for a user-supplied client.

## GitHub publisher client

Register a **GitHub App** owned by BlinkyBot. Do not use `gh auth login`, and do not register a classic OAuth App: GitHub’s classic `repo` scope would grant repository contents, which this app does not use. The desktop flow is the OAuth authorization-code grant with PKCE, the same shape as X and Gmail, with the differences GitHub requires.

- Callback URL to register, exactly: `http://127.0.0.1:47841/oauth/github/callback`
- GitHub’s loopback rule also accepts a registered callback of `http://127.0.0.1/oauth/github/callback` (the port does not have to match). Register the exact URL above so a callback check with wildcard matching disabled still succeeds. The app listens only on `127.0.0.1:47841` and does not fall back to another port.
- Authorize URL scope: `offline_access` only. That is the only scope a GitHub App accepts, and it is what returns a refresh token. Do not send `repo`, `read:org`, `gist`, or device-flow scopes.
- Repository permission: **Issues: Read and write**. This covers issue comments and pull request conversation comments on `POST /repos/{owner}/{repo}/issues/{issue_number}/comments`, plus the existing issue read used by an already granted watch. Metadata read is added by GitHub. Do not enable Contents, Pull requests, Administration, or device flow.
- Do not add a model-callable send tool. `github_comment_draft` still only creates a local draft. Posting still requires the trusted draft card. Connecting grants that draft tool for the selected Bot only. `watch_github_issue` is not granted on connect.
- Build-time public client ID: `MAIN_VITE_GITHUB_CLIENT_ID` (the GitHub App client ID, not the numeric App ID).
- Build-time client secret: `MAIN_VITE_GITHUB_CLIENT_SECRET`. GitHub’s token endpoint requires it even for a desktop public client. It is extractable from the app, same as a Google Desktop client secret, and must not be committed. PKCE binds the authorization code. `BLINKY_GITHUB_CLIENT_ID` and `BLINKY_GITHUB_CLIENT_SECRET` override those values for tests only.
- Names and empty placeholders are in `.env.example`. Real values belong in the environment or an untracked `.env.local`. `npm run dev` and `npm run build` embed whatever is present; an empty client still shows “not enabled by this distributor” and does not start browser sign-in. `Scripts/package-mac.sh`, `Scripts/package-preview.sh`, `Scripts/package-native-preview.sh`, `Scripts/dmg.sh` (when it builds), `npm run dist`, and `npm run pack` stop before packaging if `MAIN_VITE_GOOGLE_CLIENT_ID`, `MAIN_VITE_X_CLIENT_ID`, `MAIN_VITE_GITHUB_CLIENT_ID`, or `MAIN_VITE_GITHUB_CLIENT_SECRET` is empty. `MAIN_VITE_GOOGLE_CLIENT_SECRET` stays optional. Slack is not part of this required set.
- An old `gh auth` login, or `github-connection.json` version 1, does not count as connected.

## Bot and execution Agent access

The connection screen selects an applicable Bot, defaulting to the current one. A successful, verified connection durably enables only that service's read and local-draft tools for that Bot. Its execution Agent inherits the same grant. Other Bots and unrelated tools are unchanged. Bot access can be allowed or revoked on the Mac; a remotely created or copied Bot receives no new local tool/computer grants.

Authorization saving merges with concurrent Bot edits. New grants remain hidden until durable. Revocation invalidates existing gateway grants and subsequent calls; an already transmitted provider request may still complete. External writes continue through the existing draft and user-confirmation path. Connection consent or a review result is never approval to send.

Google and X keep the previous valid connection on cancelled/failed reconnects. Disconnect waits for pending refresh/auth writes before deleting local credentials, so a late response cannot restore them. Slack token rotation is persisted before use. GitHub uses the same reconnect and disconnect rules. Disconnect deletes only BlinkyBot's stored GitHub refresh token. It does not sign the user out of the GitHub CLI or github.com. A previous `gh auth login`, including the old local opt-in file, is not a BlinkyBot connection and must be replaced by this OAuth grant.

## Configuration and security

Publisher client IDs are injected into the main process at build time from `.env`, `.env.local`, `.env.production`, `.env.production.local`, or the process environment. electron-vite reads `envDir` for the main build only and embeds `MAIN_VITE_*`. The renderer does not receive that prefix. Required to package: `MAIN_VITE_GOOGLE_CLIENT_ID`, `MAIN_VITE_X_CLIENT_ID`, `MAIN_VITE_GITHUB_CLIENT_ID`, and `MAIN_VITE_GITHUB_CLIENT_SECRET`. `MAIN_VITE_GOOGLE_CLIENT_SECRET` is optional and is embedded only when the Google Desktop client requires it. X takes no secret. Slack is not required for this package gate. `.env.example` lists the names with empty values. Do not commit client IDs or secrets. Desktop binaries can be inspected: never bundle confidential server secrets, account tokens, or refresh tokens. The GitHub and optional Google values are extractable public-client secrets, not server credentials. Runtime `BLINKY_*` overrides are for tests only and are not a substitute for the packaged `MAIN_VITE_*` values.

A VM-targeted Bot cannot silently fall back to host account tools. Unsupported CLI adapters do not acquire a gateway merely because another adapter passed a test. Folder, app, operating-system and send permissions retain their existing enforcement.

## Verification limits

Isolated synthetic OAuth/CLI services exercised default Bot grants, actual Bot/Agent gateway tool calls, unrelated-Bot denial, revocation, restart and concurrent saves. The combined candidate was also opened in a real mounted Preview Electron window. These checks do not establish real provider registration, account consent, system Keychain availability or external API entitlement. Real account and device validation remains separate, and no real messages or credentials are needed for the synthetic suite.
