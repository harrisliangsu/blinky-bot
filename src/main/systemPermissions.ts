/**
 * Live macOS permission status. Missing answers stay unknown; nothing here
 * writes TCC or pretends a grant exists.
 */

import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import {
  permissionById,
  statusForPermission,
  type MediaKind,
  type SystemPermissionStatus
} from '../shared/systemPermissions'

type Preferences = {
  getMediaAccessStatus?(kind: MediaKind): string
  isTrustedAccessibilityClient?(prompt: boolean): boolean
}

function preferences(): Preferences | null {
  if (process.platform !== 'darwin') return null
  try {
    const electron = createRequire(import.meta.url)('electron') as { systemPreferences?: Preferences }
    return electron.systemPreferences ?? null
  } catch {
    return null
  }
}

export async function probeFullDisk(): Promise<SystemPermissionStatus> {
  try {
    await access(join(homedir(), 'Library', 'Mail'))
    return 'granted'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') return 'denied'
    return 'unknown'
  }
}

export async function querySystemPermissions(ids: readonly string[]): Promise<Array<{ id: string; status: SystemPermissionStatus }>> {
  const prefs = preferences()
  const fullDisk = ids.includes('full-disk-access') ? await probeFullDisk() : 'unknown'
  return ids.filter((id) => permissionById(id)).map((id) => ({
    id,
    status: statusForPermission(id, {
      media: (kind) => {
        try { return prefs?.getMediaAccessStatus?.(kind) } catch { return undefined }
      },
      accessibility: prefs ? (() => { try { return prefs.isTrustedAccessibilityClient?.(false) } catch { return undefined } })() : undefined,
      fullDisk
    })
  }))
}

export async function openSystemPermission(id: string): Promise<void> {
  const item = permissionById(id)
  if (!item) throw new Error('Unknown system permission.')
  const electron = createRequire(import.meta.url)('electron') as { shell?: { openExternal(url: string): Promise<void> } }
  if (!electron.shell) throw new Error('System Settings can only be opened from the Mac app.')
  await electron.shell.openExternal(item.url)
}
