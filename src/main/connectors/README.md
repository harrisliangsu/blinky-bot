# App connections

BlinkyBot uses the system browser for supported OAuth consent. It does not embed provider login pages, copy browser cookies, reuse another application's client identity, or ship user tokens.

| Service | Connection | Distribution prerequisite |
| --- | --- | --- |
| GitHub | Official `gh auth login --web --hostname github.com`, or reuse the user's existing official CLI login | Official `gh`; the user completes browser/device consent |
| Gmail / Calendar | Desktop OAuth with PKCE and a temporary loopback callback; separate service consent | Publisher-owned Google Desktop client, enabled APIs, consent screen and applicable verification |
| X | Native public-client PKCE | Publisher-owned Native client and applicable API access |
| Slack | Public desktop PKCE for a selected workspace/channel; existing Socket Mode remains compatible | Publisher-owned public client/distribution settings; workspace approval where required |

See [publisher registration](registration/README.md) for exact callbacks, scopes and build configuration. The current candidate has no production Google/X/Slack publisher client configuration. Ordinary users should not have to register developer applications; missing publisher configuration is shown honestly, with a separate advanced option for a user-supplied client.

## Bot and execution Agent access

The connection screen selects an applicable Bot, defaulting to the current one. A successful, verified connection durably enables only that service's read and local-draft tools for that Bot. Its execution Agent inherits the same grant. Other Bots and unrelated tools are unchanged. Bot access can be allowed or revoked on the Mac; a remotely created or copied Bot receives no new local tool/computer grants.

Authorization saving merges with concurrent Bot edits. New grants remain hidden until durable. Revocation invalidates existing gateway grants and subsequent calls; an already transmitted provider request may still complete. External writes continue through the existing draft and user-confirmation path. Connection consent or a review result is never approval to send.

Google and X keep the previous valid connection on cancelled/failed reconnects. Disconnect waits for pending refresh/auth writes before deleting local credentials, so a late response cannot restore them. Slack token rotation is persisted before use. GitHub disconnection disables this app's connection while preserving the user's global `gh` login.

## Configuration and security

Publisher public IDs are injected into the main process at build time. Desktop binaries can be inspected: never bundle confidential server secrets, account tokens or refresh tokens. Provider credentials use the existing system-encrypted storage. Runtime overrides are for explicit local distribution tests, not a replacement for publisher configuration.

A VM-targeted Bot cannot silently fall back to host account tools. Unsupported CLI adapters do not acquire a gateway merely because another adapter passed a test. Folder, app, operating-system and send permissions retain their existing enforcement.

## Verification limits

Isolated synthetic OAuth/CLI services exercised default Bot grants, actual Bot/Agent gateway tool calls, unrelated-Bot denial, revocation, restart and concurrent saves. The combined candidate was also opened in a real mounted Preview Electron window. These checks do not establish real provider registration, account consent, system Keychain availability or external API entitlement. Real account and device validation remains separate, and no real messages or credentials are needed for the synthetic suite.
