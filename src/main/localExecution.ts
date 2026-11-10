import { localExecutionPolicy } from '../shared/localExecution'
import type { Settings } from '../shared/settings'

type PermissionSettings = Pick<Settings, 'localExecutionPolicy' | 'approvalPolicy' | 'automaticReview' | 'asklist' | 'denylist' | 'semanticPermissionRules' | 'allowlist'>
const listeners = new Set<(settings: PermissionSettings) => void>()

/** The settings owner publishes here without making pure tool modules load the store. */
export function noteLocalPermissionSettings(settings: PermissionSettings): void {
  for (const listener of [...listeners]) listener(settings)
}

/** A settings change revokes an in-flight local operation, including its process group. */
export function localOperationSignal(parent: AbortSignal, settings?: PermissionSettings, independent = false): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const fingerprint = (s?: PermissionSettings): string => JSON.stringify(independent ? [localExecutionPolicy(s), s?.asklist, s?.denylist] : [localExecutionPolicy(s), s?.automaticReview, s?.asklist, s?.denylist, s?.semanticPermissionRules, s?.allowlist])
  const initial = fingerprint(settings)
  const listener = (next: PermissionSettings): void => {
    if (fingerprint(next) !== initial) {
      controller.abort(new Error('本机执行权限已更改，本轮已停止。 / Local execution permission changed; this task was stopped.'))
    }
  }
  listeners.add(listener)
  return { signal: AbortSignal.any([parent, controller.signal]), dispose: () => { listeners.delete(listener) } }
}
