import { useEffect, useRef, useState, type ReactNode } from 'react'
import { INSTALLED_APP_IDS, type AppStatus, type InstalledAppId } from '../../../shared/apps'
import { resolveSettingsLang } from '../lib/settingsCopy'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { loadBots, useAppState } from '../state'
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
  const { settings, bots } = useAppState()
  const availableBots = bots.filter(bot => !bot.archived && bot.computerTarget.kind !== 'vm')
  const zh = resolveSettingsLang(settings?.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'
  const [rows, setRows] = useState<AppStatus[]>(() => recent() ? recentStatuses!.rows : readLastAppStatuses(window.localStorage))
  const [fresh, setFresh] = useState<Set<AppStatus['id']>>(() => new Set(recent() ? recentStatuses!.rows.map((item) => item.id) : []))
  const requestVersion = useRef(0)
  const [statusError, setStatusError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [connectedOnly, setConnectedOnly] = useState(false)
  const [selected, setSelected] = useState<InstalledAppId | null>(initialApp)

  const load = (force = false): void => {
    if (!force && recent()) { setLoading(false); return }
    if (force) recentStatuses = undefined
    const version = ++requestVersion.current
    setLoading(true)
    void window.openbot.apps.status().then((next) => {
      if (version !== requestVersion.current) return
      if (!next.length) throw new Error('No app statuses returned')
      recentStatuses = { rows: next, at: Date.now() }
      setRows(next); setFresh(new Set(next.map((item) => item.id))); setStatusError(false)
      saveLastAppStatuses(window.localStorage, next)
    }).catch(() => { if (version === requestVersion.current) { recentStatuses = undefined; setFresh(new Set()); setStatusError(true) } })
      .finally(() => { if (version === requestVersion.current) setLoading(false) })
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

  const visible = (id: InstalledAppId): boolean =>
    APP_LABELS[id].toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && (!connectedOnly || row(id)?.status === 'connected')
  const anyVisible = INSTALLED_APP_IDS.some((id) => visible(id))
  const refresh = (): void => { load(true); void loadBots() }

  const detail = selected && (selected === 'github' || selected === 'gmail' || selected === 'x') ? (
    selected === 'github'
      ? <GitHubConnectCard zh={zh} status={row('github')} statusLabel={label(row('github'))} bots={availableBots} refresh={refresh} />
      : selected === 'gmail'
        ? <GoogleConnectCard zh={zh} service="gmail" status={row('gmail')} statusLabel={label(row('gmail'))} bots={availableBots} refresh={refresh} />
        : <XConnectCard zh={zh} status={row('x')} statusLabel={label(row('x'))} bots={availableBots} refresh={refresh} />
  ) : null

  return (
    <div className="ob-apps" data-apps="" data-app-view={selected ? 'detail' : 'list'}>
      <div className="ob-apps-intro"><p className="ob-hint">{copy.intro}</p><button type="button" className="ob-btn ob-btn-sm" onClick={() => load(true)} disabled={loading}>{copy.refresh}</button></div>
      {rows.some(item => item.detail === 'bot-access-not-saved') ? <p role="alert" className="ob-notice ob-notice-error">{zh ? '应用已连接，但 Bot 工具权限未保存。请在应用详情里允许此 Bot 使用。' : 'The app connected, but Bot access was not saved. Allow the Bot from the app detail.'}</p> : null}
      {statusError ? <p className="ob-notice ob-notice-error" role="alert">{zh ? '无法获取应用状态，请重试。' : 'Could not check app status. Please try again.'}</p> : null}
      {selected ? (
        <div className="ob-app-detail">
          <button type="button" className="ob-btn ob-btn-sm ob-app-back" onClick={() => setSelected(null)}>{zh ? '返回' : 'Back'}</button>
          {detail}
        </div>
      ) : (
        <>
          <input type="search" className="ob-input ob-apps-search" aria-label={zh ? '搜索应用' : 'Search apps'} placeholder={zh ? '搜索应用' : 'Search apps'} value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="ob-apps-filters" role="group" aria-label={zh ? '筛选应用' : 'Filter apps'}><button type="button" className="ob-btn ob-btn-sm" aria-pressed={!connectedOnly} onClick={() => setConnectedOnly(false)}>{zh ? '全部' : 'All'}</button><button type="button" className="ob-btn ob-btn-sm" aria-pressed={connectedOnly} onClick={() => setConnectedOnly(true)}>{zh ? '已连接' : 'Connected'}</button></div>
          <h3 className="ob-apps-heading">{connectedOnly ? (zh ? '已连接' : 'Connected') : (zh ? '应用' : 'Apps')}</h3>
          {!anyVisible ? <p className="ob-hint">{zh ? '没有匹配的应用。' : 'No matching apps.'}</p> : null}
          <div className="ob-app-list">
            {INSTALLED_APP_IDS.filter(visible).map((id) => {
              const item = row(id)
              const connected = item?.status === 'connected'
              const account = item?.account ? (id === 'x' ? `@${item.account}` : item.account) : ''
              return <div key={id} className="ob-app-row" data-app={id}>
                <button type="button" className="ob-app-row-main" onClick={() => setSelected(id)}>
                  <span className="ob-app-icon" aria-hidden="true">{APP_ICONS[id]}</span>
                  <span className="ob-app-summary"><strong>{APP_LABELS[id]}</strong><span className="ob-set-value">{label(item)}{account ? ` · ${account}` : ''}</span></span>
                </button>
                {connected ? null : <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" onClick={() => setSelected(id)}>{copy.connect}</button>}
              </div>
            })}
          </div>
        </>
      )}
    </div>
  )
}
