/**
 * Approval requests: what OpenBOT shows the user, and what it sends back.
 *
 * Both halves are security-critical and are kept together because they answer
 * the same message: `describeApproval` decides whether a request can be
 * governed at all (null = refuse), and `approvalResponse` speaks the per-method
 * dialect that refusal or consent has to be written in. Every shape here was
 * checked against the schema the installed binary emits (`codex app-server
 * generate-json-schema --out <dir>`).
 */

import { isPlainObject } from '../lenientJson'
import type { BackendApproval, BackendApprovalDecision } from '../types'
import { fileUpdates, joinCommand, str, type CodexItems, type FileUpdate } from './codexItems'

/* ── answering an approval request ───────────────────────────────── */

const REJECTION = 'Rejected in BlinkyBot.'

/**
 * The response each approval method actually accepts.
 *
 * Every answer OpenBOT sent was the wrong shape, so Codex could not complete a
 * single command or edit. The v2 methods take a
 * `CommandExecutionApprovalDecision` / `FileChangeApprovalDecision`, whose only
 * string forms are `accept | acceptForSession | decline | cancel` — we were
 * sending the v1 `ReviewDecision` vocabulary (`approved`,
 * `approved_for_session`, `{ denied: { rejection } }`) to all of them. Only the
 * two legacy methods, `execCommandApproval` and `applyPatchApproval`, speak
 * that dialect, and `item/permissions/requestApproval` speaks neither: its
 * response has no `decision` field at all.
 *
 * `cancel` is deliberately never sent for a refusal. `decline` refuses the one
 * action and lets the agent try something else; `cancel` tears down the whole
 * turn, which is not what the user said when they answered one prompt.
 */
export function approvalResponse(
  method: string,
  params: unknown,
  decision: BackendApprovalDecision
): unknown {
  if (method.includes('permissions')) return permissionsResponse(params, decision)

  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    if (decision === 'approve') return { decision: 'approved' }
    if (decision === 'approve-always') return { decision: 'approved_for_session' }
    return { decision: { denied: { rejection: REJECTION } } }
  }

  if (decision === 'approve') return { decision: 'accept' }
  if (decision === 'approve-always') return { decision: 'acceptForSession' }
  return { decision: 'decline' }
}

/**
 * `PermissionsRequestApprovalResponse` is a grant, not a verdict: it wants a
 * `GrantedPermissionProfile` under `permissions`, plus an optional `scope` and
 * `strictAutoReview`. Refusing therefore means granting nothing — an empty
 * profile — and approving means handing back exactly the profile that was
 * requested, never a wider one. `scope` defaults to `turn`; `session` is the
 * closest thing the protocol has to "always allow".
 */
function permissionsResponse(params: unknown, decision: BackendApprovalDecision): unknown {
  const p = isPlainObject(params) ? params : {}
  const requested = isPlainObject(p.permissions) ? p.permissions : null
  if (decision === 'reject' || !requested) return { permissions: {}, scope: 'turn' }
  return { permissions: requested, scope: decision === 'approve-always' ? 'session' : 'turn' }
}

/* ── describing an approval request ──────────────────────────────── */

/** Diffs are shown in full up to this; a whole-file rewrite is not a dialog. */
const MAX_DETAIL_CHARS = 12_000

/**
 * Describe an approval request, or refuse it by returning null.
 *
 * Null is the fail-CLOSED answer, and it is the point of this function's
 * shape. The default branch used to return `kind: 'shell'` with the detail
 * `'a command'` for anything it did not recognise, and `chatRequest.ts` then
 * ran `analyzeCommand('a command', denylist)` — which matches nothing, so the
 * user's denylist silently did not apply and they were asked to approve an
 * action nobody could name. A request this cannot render is one OpenBOT cannot
 * govern, so it is declined rather than shown.
 */
export function describeApproval(
  method: string,
  params: unknown,
  items?: CodexItems
): BackendApproval | null {
  const p = isPlainObject(params) ? params : {}

  if (method.includes('fileChange') || method === 'applyPatchApproval') {
    return describeFileChange(p, items)
  }
  if (method.includes('permissions')) return describePermissions(p)
  if (method.includes('commandExecution') || method === 'execCommandApproval') {
    return describeCommand(p, items)
  }
  return null
}

function describeCommand(
  p: Record<string, unknown>,
  items?: CodexItems
): BackendApproval | null {
  const item = isPlainObject(p.item) ? p.item : {}
  const command =
    // v2 sends a string; v1 `ExecCommandApprovalParams.command` is an argv
    // array, which `str()` rendered as '' — and the array fallback was only
    // ever checked on `p.command`, never on `item.command`.
    str(p.command) ||
    joinCommand(p.command) ||
    str(item.command) ||
    joinCommand(item.command) ||
    actionCommand(p.commandActions) ||
    actionCommand(p.parsedCmd) ||
    items?.command(str(p.itemId)) ||
    ''
  if (!command) return null
  return { kind: 'shell', summary: `Codex wants to run: ${command}`, detail: command, target: command }
}

/** `CommandAction[]` (v2, `command`) or `ParsedCommand[]` (v1, `cmd`). */
function actionCommand(value: unknown): string {
  if (!Array.isArray(value)) return ''
  for (const raw of value) {
    if (!isPlainObject(raw)) continue
    const text = str(raw.command) || str(raw.cmd)
    if (text) return text
  }
  return ''
}

function describeFileChange(
  p: Record<string, unknown>,
  items?: CodexItems
): BackendApproval | null {
  // The request's own payload first — v1 `applyPatchApproval` carries the whole
  // patch — then what the notification stream said about this item.
  const changes = firstNonEmpty(
    fileUpdates(p.changes),
    patchChanges(p.fileChanges),
    items?.fileChange(str(p.itemId)) ?? []
  )
  const reason = str(p.reason)
  const grantRoot = str(p.grantRoot)
  if (changes.length === 0 && !reason && !grantRoot) return null

  const paths = changes.map((change) => change.path)
  const summary = paths.length
    ? `Codex wants to edit ${paths.length === 1 ? paths[0] : `${paths.length} files`}`
    : grantRoot
      ? `Codex wants write access under ${grantRoot}`
      : `Codex wants to edit files: ${reason}`
  const detail = [renderPatch(changes), reason, changes.length ? '' : grantRoot]
    .filter(Boolean)
    .join('\n\n')
  const target = paths.join(', ') || grantRoot || reason
  return { kind: 'edit', summary, detail, target }
}

/** v1 `applyPatchApproval` sends a map of path -> `FileChange`. */
function patchChanges(value: unknown): FileUpdate[] {
  if (!isPlainObject(value)) return []
  const updates: FileUpdate[] = []
  for (const [path, raw] of Object.entries(value)) {
    if (!isPlainObject(raw)) continue
    updates.push({ path, diff: str(raw.unified_diff) || str(raw.content) })
  }
  return updates
}

function renderPatch(changes: FileUpdate[]): string {
  if (changes.length === 0) return ''
  const text = changes
    .map((change) => (change.diff ? `${change.path}\n${change.diff}` : change.path))
    .join('\n\n')
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}\n…` : text
}

function firstNonEmpty(...candidates: FileUpdate[][]): FileUpdate[] {
  for (const candidate of candidates) if (candidate.length > 0) return candidate
  return []
}

/**
 * `PermissionsRequestApprovalParams.permissions` is what the agent is asking
 * for, and the schema makes it required — so an unnameable permission request
 * is shape drift, and gets the same refusal as an unnameable command.
 */
function describePermissions(p: Record<string, unknown>): BackendApproval | null {
  const wanted = describeProfile(p.permissions)
  const reason = str(p.reason)
  if (!wanted && !reason) return null
  const what = wanted || reason
  return {
    kind: 'mcp',
    summary: `Codex is requesting ${what}`,
    detail: [wanted, reason].filter(Boolean).join('\n'),
    target: what
  }
}

function describeProfile(value: unknown): string {
  if (!isPlainObject(value)) return ''
  const parts: string[] = []
  const files = isPlainObject(value.fileSystem) ? value.fileSystem : null
  if (files) {
    for (const raw of Array.isArray(files.entries) ? files.entries : []) {
      if (!isPlainObject(raw)) continue
      const path = filesystemPath(raw.path)
      if (path) parts.push(`${str(raw.access) || 'unspecified'} access to ${path}`)
    }
    // `read` and `write` are the legacy flat lists, still emitted alongside.
    for (const path of stringList(files.read)) parts.push(`read access to ${path}`)
    for (const path of stringList(files.write)) parts.push(`write access to ${path}`)
  }
  const network = isPlainObject(value.network) ? value.network : null
  if (network?.enabled === true) parts.push('network access')
  return parts.join(', ')
}

/** `FileSystemPath`: a literal path, a glob, or a named special location. */
function filesystemPath(value: unknown): string {
  if (typeof value === 'string') return value
  if (!isPlainObject(value)) return ''
  const direct = str(value.path) || str(value.pattern)
  if (direct) return direct
  const special = isPlainObject(value.value) ? value.value : null
  if (!special) return ''
  const kind = str(special.kind)
  const subpath = str(special.subpath) || str(special.path)
  return subpath ? `${kind || 'a special location'} (${subpath})` : kind
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}
