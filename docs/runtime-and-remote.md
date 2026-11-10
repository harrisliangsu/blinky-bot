# Runtime and remote workspace

## Shared capabilities and access

The LAN browser client uses the desktop React application and the same typed API/business handlers. Sharing starts only after an explicit action on the Mac. It does not publish a service to the internet or create a tunnel. A QR invitation bootstraps a device key challenge; the device must identify itself and receive an explicit, focused host approval. A name or invitation alone grants no history, messages or controls.

The host approval shows the workspace scope and view/control choice. Approved workspace devices can use browser-supported chat, sessions, Bots, groups, memory, projects, boards, tasks, ordinary clarifications, routines, skills and ordinary settings. Room-scoped grants remain confined to the approved conversation and its related task records. System/tool permissions, account login, credentials, device approval and native hardware actions remain on the Mac. Creating/copying a Bot remotely does not grant local tools or computer access.

Device requests prove key possession and bind method, path, body, time and a one-use nonce. Refusal, revocation, expiry and stopped sharing close access. Approved devices reconnect without another name/password step while their host grant remains valid. Only an explicitly enabled room keeps a safe-storage-encrypted recovery record: a normal restart resumes that listener during foreground launch on the original address and port, with the device's original eight-hour expiry not extended; stopped or revoked sharing never resurrects, and an unreadable record or unsupported safe storage keeps sharing temporary. See docs/remote-recovery.md. This is a local HTTP service for a trusted LAN, not an encrypted internet transport.

History initially loads up to 100 visible messages, then 50 older messages per signed cursor. The common transcript preserves order, deduplicates concurrent loads and holds the reading anchor. Desktop events drive browser long-poll invalidations, including final replies, later turns, task progress and reconnection. Only user-visible chat is projected; private tool/reasoning/approval content and credentials are withheld. Search projects text before matching, and uploaded file references are device-bound rather than arbitrary host paths.

## Data ownership and task choices

Global connection/preferences data belongs to the application. Each Bot owns its configuration and private memory; explicitly shared preferences remain shared. Conversation IDs own their messages, queues, provider bindings and attachment references. New loose conversations receive separate managed directories; existing explicit working directories are not migrated.

The Bot decides session reuse separately from working-directory isolation. A continuation of the same task may reuse its execution conversation. Independent or parallel work gets a new conversation. Active work receives supplementary instructions through the existing delivery path rather than a competing executor.

The host prepares isolated Git worktrees/branches for independent Git tasks, retaining tracked source changes and recording a baseline. Untracked files are not copied wholesale. Non-Git tasks receive independent output directories and can read necessary inputs through the normal authorized tools. A task may share a completed dependency's workspace or explicitly choose a shared source with a reason. Manifests and partial work survive failure/cancellation; the app does not automatically clean, reset or merge users' work. Directory ownership is not an operating-system sandbox.

The intelligent layer supplies priority, dependency and scheduling reasons. The host keeps these durable, starts only ready tasks, ages waiting work and uses the existing execution slots. Queued work does not consume running concurrency. Reprioritization does not interrupt a running task. Interrupted tasks are not silently replayed after restart. Progress reports identify the actual execution conversation, stay concise and retain Bot/source ownership and restart deduplication.

## Voice and optional decision review

Settings offer Chinese, English and the compatible system-language choice. The language is saved durably and used by the main process when starting the packaged native speech helper. Changing language/conversation cancels the previous recognition without overwriting the owned input draft. Errors preserve drafts. Browser clients can change the preference; native capture remains on the Mac.

The optional decision-review switch is persistent under General settings and defaults off for legacy and new configurations. When enabled, the intelligent layer discovers the current backend's installed skills at substantive development decisions, selects a suitable real contract and invokes it through existing authorized tools. There is no fixed provider, model or credential requirement. Missing/unavailable skills, failed/uncertain results and deadlines are recorded as unreviewed; independent work can continue. Scoped fingerprints prevent repeated unchanged reviews. Tool receipts prove execution rather than correctness or user approval.

## Verification and remaining conditions

Synthetic, isolated checks cover real mounted Preview Electron windows, actual LAN browser pages, history/realtime/reconnect, authentication negatives, Bot/Agent tool gateways, worktree/conversation ownership, scheduling, named progress, settings persistence and synthetic voice services. Both language resources were queried through the packaged native helper without requesting permission or recording audio. These are bounded verification claims, not proof of every backend, real account, physical phone scan or real speech recognition.

Google/X/Slack ordinary-user browser login still requires publisher-owned client registrations and applicable provider/API approvals. See the [app connection guide](../src/main/connectors/README.md). Native permission/Keychain checks, real provider consent and physical-device validation retain their stated external conditions. No real chat, invitation, account token or microphone input is needed for the isolated regression suite. Formal application replacement remains pending the complete delivery acceptance and release process.
