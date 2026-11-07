import { Modal } from './Modal'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppStatus } from '../../../shared/apps'
import { resolveSettingsLang } from '../lib/settingsCopy'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { loadBots, store, useAppState } from '../state'
import { BotAppAccess } from './BotAppAccess'
import './SettingsApps.css'
import { SlackConnectCard, type SlackView } from './SlackConnectCard'
import { XConnectCard } from './XConnectCard'
import { GoogleConnectCard } from './GoogleConnectCard'
import { readLastAppStatuses, saveLastAppStatuses } from './SettingsAppsStatusCache'

// Reopening the panel shortly after a successful check does not need another
// round of subprocesses and network requests. A process restart still checks.
let recentStatuses: { rows: AppStatus[]; at: number } | undefined
const RECENT_MS = 30_000
const recent = (): boolean => !!recentStatuses && Date.now() - recentStatuses.at < RECENT_MS

/** GitHub, Git, and Gmail. One connection, shared by every Bot. */
export function SettingsApps(): ReactNode {
  const copy = useSettingsCopy().apps
  const { settings, bots, session } = useAppState()
  const [accessBotId, setAccessBotId] = useState(session?.activeBotId ?? session?.botIds[0] ?? '')
  const availableBots = bots.filter(bot => !bot.archived && bot.computerTarget.kind !== 'vm')
  const accessBot = availableBots.find(bot => bot.id === accessBotId)
  const zh = resolveSettingsLang(settings?.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'
  const [rows, setRows] = useState<AppStatus[]>(() => recent() ? recentStatuses!.rows : readLastAppStatuses(window.localStorage))
  const [fresh, setFresh] = useState<Set<AppStatus['id']>>(() => new Set(recent() ? recentStatuses!.rows.map((item) => item.id) : []))
  const requestVersion = useRef(0)
  const githubLoginPending = useRef(false)
  const [gitName, setGitName] = useState('')
  const [gitEmail, setGitEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [statusError, setStatusError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [editingGit, setEditingGit] = useState(false)
  const [query, setQuery] = useState('')
  const [connectedOnly, setConnectedOnly] = useState(false)
  const [slack, setSlack] = useState<SlackView | undefined>()

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
      // GitHub may complete its durable selected-Bot grant during this status
      // request. Reload only after that acknowledgement, not in parallel.
      void loadBots()
      saveLastAppStatuses(window.localStorage, next)
    }).catch(() => { if (version === requestVersion.current) { recentStatuses = undefined; setFresh(new Set()); setStatusError(true) } })
      .finally(() => { if (version === requestVersion.current) setLoading(false) })
  }

  useEffect(() => {
    load()
    const onFocus = (): void => { const force = githubLoginPending.current; githubLoginPending.current = false; load(force) }
    window.addEventListener('focus', onFocus)
    return () => { requestVersion.current++; window.removeEventListener('focus', onFocus); void window.openbot.apps.cancelGoogle(); void window.openbot.apps.cancelX() }
  }, [])
  const loadSlack = (): void => { void window.openbot.apps.slackStatus().then((value) => {
    setSlack(value)
    const status: AppStatus = { id: 'slack', status: value.state === 'connected' ? 'connected' : value.state === 'connecting' ? 'pending' : value.state === 'error' ? 'unavailable' : 'disconnected' }
    setRows((old) => [...old.filter((row) => row.id !== 'slack'), status])
    setFresh((old) => new Set(old).add('slack'))
    saveLastAppStatuses(window.localStorage, [status])
  }).catch(() => setSlack({ state:'error' })) }
  useEffect(() => { loadSlack(); const timer = window.setInterval(loadSlack, 3000); return () => window.clearInterval(timer) }, [])

  const row = (id: AppStatus['id']): AppStatus | undefined => rows.find((item) => item.id === id)
  const label = (item: AppStatus | undefined): string => {
    if (!item) return zh ? '状态未知' : 'Status unknown'
    const value = item.status === 'connected' ? copy.connected : item.status === 'unavailable' ? copy.unavailable : item.status === 'pending' ? copy.pending : copy.disconnected
    return fresh.has(item.id) ? value : (zh ? `上次：${value}` : `Last known: ${value}`)
  }

  const github = row('github')
  const git = row('git')
  const visible = (id: AppStatus['id'], name: string): boolean =>
    name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && (!connectedOnly || row(id)?.status === 'connected')
  const anyVisible = visible('github', 'GitHub') || visible('git', 'Git') || visible('gmail', 'Gmail') || visible('calendar', 'Google Calendar') || visible('slack', 'Slack') || visible('x', 'X')

  return (
    <div className="ob-apps" data-apps="">
      <div className="ob-apps-intro"><p className="ob-hint">{zh ? '连接后允许下方所选 Bot 及其执行 Agent 使用此应用的读取和本地草稿工具。发送仍需原有确认。' : 'After connecting, allow the selected Bot and its execution Agent to use this app’s reading and local draft tools. Sending keeps its existing confirmation.'}</p><button type="button" className="ob-btn ob-btn-sm" onClick={() => load(true)} disabled={loading}>{copy.refresh}</button></div>
      <label className="ob-field"><span className="ob-label">{zh ? '允许哪个 Bot 使用' : 'Allow this Bot to use connected apps'}</span><select className="ob-select" value={accessBotId} onChange={event => setAccessBotId(event.target.value)}><option value="">{zh ? '选择 Bot' : 'Choose a Bot'}</option>{availableBots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
      {rows.some(row => row.detail === 'bot-access-not-saved') ? <p role="alert" className="ob-notice ob-notice-error">{zh ? '应用已连接，但 Bot 工具权限未保存。请点击允许此 Bot 使用重试。' : 'The app connected, but Bot access was not saved. Retry with Allow this Bot.'}</p> : null}
      <input type="search" className="ob-input ob-apps-search" aria-label={zh ? '搜索应用' : 'Search apps'} placeholder={zh ? '搜索应用' : 'Search apps'} value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="ob-apps-filters" role="group" aria-label={zh ? '筛选应用' : 'Filter apps'}><button type="button" className="ob-btn ob-btn-sm" aria-pressed={!connectedOnly} onClick={() => setConnectedOnly(false)}>{zh ? '全部' : 'All'}</button><button type="button" className="ob-btn ob-btn-sm" aria-pressed={connectedOnly} onClick={() => setConnectedOnly(true)}>{zh ? '已连接' : 'Connected'}</button></div>
      {statusError ? <p className="ob-notice ob-notice-error" role="alert">{zh ? '无法获取应用状态，请重试。' : 'Could not check app status. Please try again.'}</p> : null}
      <h3 className="ob-apps-heading">{connectedOnly ? (zh ? '已连接' : 'Connected') : (zh ? '应用' : 'Apps')}</h3>
      {!anyVisible ? <p className="ob-hint">{zh ? '没有匹配的应用。' : 'No matching apps.'}</p> : null}
      <div className="ob-apps-grid">
      {visible('github', 'GitHub') ? <section className="ob-app-card" data-app="github">
        <div className="ob-app-icon" aria-hidden="true">GH</div>
        <div className="ob-app-summary"><h3>{copy.githubTitle}</h3>
        <p className="ob-hint">{zh ? '复用本机 GitHub CLI 登录；需要登录时打开官方浏览器授权。' : 'Uses your GitHub CLI login; opens official browser authorization when needed.'}</p>
        <p className="ob-set-value">
          {label(github)}
          {github?.account ? ` · ${github.account}` : ''}
        </p>
        {github?.detail === 'gh' ? <p className="ob-hint">{copy.githubMissing}</p> : null}
        {github?.detail === 'verification-failed' ? <p className="ob-hint">{zh ? '无法验证连接，请检查 GitHub 登录和网络。' : 'Could not verify the connection. Check GitHub sign-in and the network.'}</p> : null}
        </div>
        {github?.status !== 'connected' ? <button
          type="button"
          className="ob-btn ob-btn-sm"
          data-connect="github"
          disabled={busy || !github || github.detail === 'gh'}
          onClick={() => {
            setBusy(true)
            void window.openbot.apps
              .connectGitHub(accessBot?.id)
              .then((result) => {
                if (!result.started) store.toast(copy.githubLoginFailed, 'error')
                else githubLoginPending.current = true
              })
              .catch(() => store.toast(copy.githubLoginFailed, 'error'))
              .finally(() => {
                setBusy(false)
                load(true); void loadBots()
              })
          }}
        >
          {zh ? '浏览器登录' : 'Sign in with browser'}
        </button> : <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => { setBusy(true); void window.openbot.apps.disconnectGitHub().then((result) => { if (!result.ok) store.toast(zh ? '无法断开 GitHub。' : 'Could not disconnect GitHub.', 'error') }).catch(() => store.toast(zh ? '无法断开 GitHub。' : 'Could not disconnect GitHub.', 'error')).finally(() => { setBusy(false); load(true) }) }}>{zh ? '断开' : 'Disconnect'}</button>}
        <p className="ob-hint ob-apps-connection-note">{zh ? '断开仅停用 BlinkyBot 的 GitHub 连接，保留本机 gh 登录。' : 'Disconnect disables GitHub in BlinkyBot and keeps your local gh login.'}</p>
        {accessBot ? <BotAppAccess service="github" bot={accessBot} connected={github?.status === 'connected'} zh={zh} /> : null}
      </section> : null}

      {visible('git', 'Git') ? <section className="ob-app-card" data-app="git">
        <div className="ob-app-icon" aria-hidden="true">Git</div>
        <div className="ob-app-summary"><h3>{copy.gitTitle}</h3>
        <p className="ob-hint">{copy.gitHint}</p>
        <p className="ob-set-value">
          {label(git)}
          {git?.account ? ` · ${git.account}` : ''}
        </p>
        {git?.detail === 'git' ? <p className="ob-hint">{copy.gitMissing}</p> : null}
        {git?.detail === 'verification-failed' ? <p className="ob-hint">{zh ? '无法读取 Git 配置，请检查本机环境。' : 'Could not read Git configuration. Check the local environment.'}</p> : null}
        {git?.detail === 'invalid' ? <p className="ob-hint">{copy.gitInvalid}</p> : null}
        {git?.detail === 'failed' ? <p className="ob-hint">{copy.gitFailed}</p> : null}
        </div>
        <button type="button" className="ob-btn ob-btn-sm" aria-expanded={editingGit} onClick={() => setEditingGit((current) => !current)} disabled={!git || git.status === 'unavailable'}>{editingGit ? (zh ? '取消' : 'Cancel') : (zh ? '设置' : 'Configure')}</button>
        {editingGit ? <Modal title={zh ? 'Git 设置' : 'Git settings'} onClose={() => setEditingGit(false)} size="sm"><div className="ob-apps-git">
          <input
            className="ob-input"
            aria-label={copy.gitName}
            placeholder={copy.gitName}
            value={gitName}
            onChange={(e) => setGitName(e.target.value)}
          />
          <input
            className="ob-input"
            aria-label={copy.gitEmail}
            placeholder={copy.gitEmail}
            value={gitEmail}
            onChange={(e) => setGitEmail(e.target.value)}
          />
          <button
            type="button"
            className="ob-btn ob-btn-sm"
            data-connect="git"
            disabled={busy || !git || git.status === 'unavailable' || !gitName.trim() || !gitEmail.trim()}
            onClick={() => {
              setBusy(true)
              void window.openbot.apps
                .connectGit(gitName, gitEmail)
                .then((next) => { setRows((current) => current.map((item) => (item.id === 'git' ? next : item))); setFresh((old) => new Set(old).add('git')); saveLastAppStatuses(window.localStorage, [next]); if (next.status === 'connected') setEditingGit(false); load(true) })
                .catch(() => store.toast(copy.gitFailed, 'error'))
                .finally(() => setBusy(false))
            }}
          >
            {copy.gitSave}
          </button>
        </div></Modal> : null}
      </section> : null}

      {(['gmail', 'calendar'] as const).map((service) => visible(service, service === 'gmail' ? 'Gmail' : 'Google Calendar') ? <GoogleConnectCard key={service} zh={zh} service={service} status={row(service)} statusLabel={label(row(service))} accessBot={accessBot} refresh={() => { load(true); void loadBots() }} /> : null)}
      {visible('slack', 'Slack') ? <SlackConnectCard zh={zh} bots={bots} status={slack} statusLabel={slack ? undefined : label(row('slack'))} accessBot={accessBot} refresh={() => { loadSlack(); void loadBots() }} /> : null}
      {visible('x', 'X') ? <XConnectCard zh={zh} status={row('x')} statusLabel={label(row('x'))} accessBot={accessBot} refresh={() => { load(true); void loadBots() }} /> : null}
      </div>
    </div>
  )
}
