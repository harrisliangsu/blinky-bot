import { useEffect, useRef, useState, type ReactNode } from 'react'
import { INSTALLED_APP_IDS, type AppStatus, type InstalledAppId } from '../../../shared/apps'
import { resolveSettingsLang } from '../lib/settingsCopy'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { useAppState } from '../state'
import './SettingsApps.css'
import { XConnectCard } from './XConnectCard'
import { GoogleConnectCard } from './GoogleConnectCard'
import { GitHubConnectCard } from './GitHubConnectCard'
import { readLastAppStatuses, saveLastAppStatuses } from './SettingsAppsStatusCache'

// Reopening the panel shortly after a successful check does not need another
// round of subprocesses and network requests. A process restart still checks.
let recentStatuses: { rows: AppStatus[]; at: number } | undefined
const RECENT_MS = 30_000
const recent = (): boolean => !!recentStatuses && Date.now() - recentStatuses.at < RECENT_MS

const APP_LABELS: Record<InstalledAppId, string> = { github: 'GitHub', gmail: 'Gmail', x: 'X' }
const APP_ICONS: Record<InstalledAppId, string> = { github: 'GH', gmail: 'M', x: '𝕏' }

/** GitHub, Gmail, and X. One connection, shared by every Bot. */
export function SettingsApps({ initialApp = null }: { initialApp?: InstalledAppId | null } = {}): ReactNode {
  const copy = useSettingsCopy().apps
  const { settings } = useAppState()
  const zh = resolveSettingsLang(settings?.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'
  const [rows, setRows] = useState<AppStatus[]>(() => recent() ? recentStatuses!.rows : readLastAppStatuses(window.localStorage))
  const [fresh, setFresh] = useState<Set<AppStatus['id']>>(() => new Set(recent() ? recentStatuses!.rows.map((item) => item.id) : []))
  const requestVersion = useRef(0)
  const [statusError, setStatusError] = useState(false)
  const [selected, setSelected] = useState<InstalledAppId | null>(initialApp)

  const load = (force = false): void => {
    if (!force && recent()) return
    if (force) recentStatuses = undefined
    const version = ++requestVersion.current
    void window.openbot.apps.status().then((next) => {
      if (version !== requestVersion.current) return
      if (!next.length) throw new Error('No app statuses returned')
      recentStatuses = { rows: next, at: Date.now() }
      setRows(next); setFresh(new Set(next.map((item) => item.id))); setStatusError(false)
      saveLastAppStatuses(window.localStorage, next)
    }).catch(() => { if (version === requestVersion.current) { recentStatuses = undefined; setFresh(new Set()); setStatusError(true) } })
  }

  useEffect(() => {
    load()
    return () => { requestVersion.current++; void window.openbot.apps.cancelGoogle(); void window.openbot.apps.cancelX(); void window.openbot.apps.cancelGitHub() }
  }, [])

  const row = (id: AppStatus['id']): AppStatus | undefined => rows.find((item) => item.id === id)
  const label = (item: AppStatus | undefined): string => {
    if (!item) return zh ? '状态未知' : 'Status unknown'
    const value = item.status === 'connected' ? copy.connected : item.status === 'unavailable' ? copy.unavailable : item.status === 'pending' ? copy.pending : copy.disconnected
    return fresh.has(item.id) ? value : (zh ? `上次：${value}` : `Last known: ${value}`)
  }
  const refresh = (): void => load(true)

  const detail = selected && (selected === 'github' || selected === 'gmail' || selected === 'x') ? (
    selected === 'github'
      ? <GitHubConnectCard zh={zh} status={row('github')} statusLabel={label(row('github'))} refresh={refresh} />
      : selected === 'gmail'
        ? <GoogleConnectCard zh={zh} service="gmail" status={row('gmail')} statusLabel={label(row('gmail'))} refresh={refresh} />
        : <XConnectCard zh={zh} status={row('x')} statusLabel={label(row('x'))} refresh={refresh} />
  ) : null

  return (
    <div className="ob-apps" data-apps="" data-app-view={selected ? 'detail' : 'list'}>
      <p className="ob-hint ob-apps-intro">{copy.intro}</p>
      {statusError ? <p className="ob-notice ob-notice-error" role="alert">{zh ? '无法获取应用状态，请重试。' : 'Could not check app status. Please try again.'}</p> : null}
      {selected ? (
        <div className="ob-app-detail">
          <button type="button" className="ob-btn ob-btn-sm ob-btn-ghost ob-app-back" onClick={() => setSelected(null)}>{zh ? '返回' : 'Back'}</button>
          {detail}
        </div>
      ) : (
        <div className="ob-app-grid" data-app-layout="grid">
          {INSTALLED_APP_IDS.map((id) => {
            const item = row(id)
            const connected = item?.status === 'connected'
            const account = item?.account ? (id === 'x' ? `@${item.account}` : item.account) : ''
            return <div key={id} className="ob-app-tile" data-app={id}>
              <button type="button" className="ob-app-tile-open" onClick={() => setSelected(id)}>
                <span className="ob-app-icon" aria-hidden="true">{APP_ICONS[id]}</span>
                <span className="ob-app-tile-copy">
                  <strong>{APP_LABELS[id]}</strong>
                  <span className="ob-set-value">{label(item)}{connected && account ? ` · ${account}` : ''}</span>
                </span>
              </button>
              {connected ? null : <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" onClick={() => setSelected(id)}>{copy.connect}</button>}
            </div>
          })}
        </div>
      )}
    </div>
  )
}
