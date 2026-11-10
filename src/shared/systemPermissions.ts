/**
 * macOS Privacy & Security entries the Settings 权限 page can show.
 *
 * Deep links use the `x-apple.systempreferences:` scheme. System Settings on
 * macOS Ventura and later still opens these panes; this is not the pre-Ventura
 * System Preferences app name. The renderer never supplies a URL.
 */

export type SystemPermissionId =
  | 'screen-recording'
  | 'accessibility'
  | 'input-monitoring'
  | 'notifications'
  | 'camera'
  | 'microphone'
  | 'automation'
  | 'full-disk-access'
  | 'files-and-folders'
  | 'local-network'

export type SystemPermissionStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'

export interface SystemPermissionDef {
  id: SystemPermissionId
  zh: string
  en: string
  /** Opens the matching Privacy & Security (or Notifications) pane. */
  url: string
  /** Pre-populated because this app already depends on it. */
  initial: boolean
}

export const SYSTEM_PERMISSIONS: readonly SystemPermissionDef[] = [
  {
    id: 'screen-recording',
    zh: '屏幕录制',
    en: 'Screen Recording',
    url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    initial: true
  },
  {
    id: 'accessibility',
    zh: '辅助功能',
    en: 'Accessibility',
    url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    initial: true
  },
  {
    id: 'automation',
    zh: '自动化',
    en: 'Automation',
    url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
    initial: true
  },
  {
    id: 'microphone',
    zh: '麦克风',
    en: 'Microphone',
    url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    initial: true
  },
  {
    id: 'notifications',
    zh: '通知',
    en: 'Notifications',
    url: 'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
    initial: true
  },
  {
    id: 'input-monitoring',
    zh: '输入监听',
    en: 'Input Monitoring',
    url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
    initial: false
  },
  {
    id: 'camera',
    zh: '相机',
    en: 'Camera',
    url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    initial: false
  },
  {
    id: 'full-disk-access',
    zh: '完全磁盘访问',
    en: 'Full Disk Access',
    url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
    initial: false
  },
  {
    id: 'files-and-folders',
    zh: '文件与文件夹',
    en: 'Files and Folders',
    url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
    initial: false
  },
  {
    id: 'local-network',
    zh: '本地网络',
    en: 'Local Network',
    url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork',
    initial: false
  }
]

const BY_ID = new Map(SYSTEM_PERMISSIONS.map((item) => [item.id, item]))

export function permissionById(id: string): SystemPermissionDef | undefined {
  return BY_ID.get(id as SystemPermissionId)
}

export function initialPermissionIds(): SystemPermissionId[] {
  return SYSTEM_PERMISSIONS.filter((item) => item.initial).map((item) => item.id)
}

export interface PermissionListState {
  /** Built-in rows the user hid. Hiding does not revoke the OS grant. */
  hidden: string[]
  /** Catalog ids the user added. */
  added: string[]
}

export const EMPTY_PERMISSION_LIST: PermissionListState = { hidden: [], added: [] }

export function visiblePermissionIds(state: PermissionListState = EMPTY_PERMISSION_LIST): SystemPermissionId[] {
  const hidden = new Set(state.hidden)
  const ids = [
    ...initialPermissionIds().filter((id) => !hidden.has(id)),
    ...state.added.filter((id): id is SystemPermissionId => !!permissionById(id) && !initialPermissionIds().includes(id as SystemPermissionId) && !hidden.has(id))
  ]
  return [...new Set(ids)]
}

export function addPermission(state: PermissionListState, id: string): PermissionListState {
  if (!permissionById(id)) return state
  const hidden = state.hidden.filter((item) => item !== id)
  const added = state.added.includes(id) || initialPermissionIds().includes(id as SystemPermissionId) ? state.added : [...state.added, id]
  return { hidden, added }
}

/** Hide a row. This does not change the operating-system grant. */
export function removePermission(state: PermissionListState, id: string): PermissionListState {
  if (!permissionById(id)) return state
  return {
    hidden: state.hidden.includes(id) ? state.hidden : [...state.hidden, id],
    added: state.added.filter((item) => item !== id)
  }
}

const STORAGE_KEY = 'openbot:system-permission-list'

export function readPermissionList(storage: { getItem(key: string): string | null }): PermissionListState {
  try {
    const raw = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as Partial<PermissionListState>
    const hidden = Array.isArray(raw.hidden) ? raw.hidden.filter((id) => typeof id === 'string' && permissionById(id)) : []
    const added = Array.isArray(raw.added) ? raw.added.filter((id) => typeof id === 'string' && permissionById(id)) : []
    return { hidden, added }
  } catch {
    return EMPTY_PERMISSION_LIST
  }
}

export function writePermissionList(storage: { setItem(key: string, value: string): void }, state: PermissionListState): void {
  storage.setItem(STORAGE_KEY, JSON.stringify({ hidden: state.hidden, added: state.added }))
}

export function statusLabel(status: SystemPermissionStatus, zh: boolean): string {
  if (status === 'granted') return zh ? '已授权' : 'Granted'
  if (status === 'denied' || status === 'restricted') return zh ? '未授权' : 'Not granted'
  if (status === 'not-determined') return zh ? '未确定' : 'Not determined'
  return zh ? '未知' : 'Unknown'
}

/** Electron's media-access string, or unknown when the OS did not answer. */
export function mediaStatus(raw: string | undefined): SystemPermissionStatus {
  if (raw === 'granted' || raw === 'denied' || raw === 'restricted' || raw === 'not-determined' || raw === 'unknown') return raw
  return 'unknown'
}

/** Accessibility is a boolean. False is not granted; a missing answer is unknown. */
export function accessibilityStatus(trusted: boolean | undefined): SystemPermissionStatus {
  if (trusted === true) return 'granted'
  if (trusted === false) return 'denied'
  return 'unknown'
}

export type MediaKind = 'microphone' | 'camera' | 'screen'

export function statusForPermission(
  id: string,
  probes: {
    media?: (kind: MediaKind) => string | undefined
    accessibility?: boolean
    fullDisk?: SystemPermissionStatus
  }
): SystemPermissionStatus {
  if (!permissionById(id)) return 'unknown'
  if (id === 'screen-recording') return mediaStatus(probes.media?.('screen'))
  if (id === 'microphone') return mediaStatus(probes.media?.('microphone'))
  if (id === 'camera') return mediaStatus(probes.media?.('camera'))
  if (id === 'accessibility') return accessibilityStatus(probes.accessibility)
  if (id === 'full-disk-access') return probes.fullDisk ?? 'unknown'
  return 'unknown'
}
