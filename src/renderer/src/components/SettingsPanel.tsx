import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { runtimeModels } from '../../../shared/botRuntime'
import { listedBackends } from '../../../shared/backendSections'
import { thinkingOptions, thinkingWire, type ThinkingDepth } from '../../../shared/thinking'
import type { AgentMode, Settings, UpdateReport } from '../../../shared/types'
import { SETTINGS_SECTIONS, takeSettingsTab, rememberSettingsSection, settingsScroll, saveSettingsScroll, type SettingsSection } from '../lib/settingsNavigation'
import { resolveSettingsLang, updateStatusText } from '../lib/settingsCopy'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { loadSettings, store, updateSettings, useAppState } from '../state'
import { IconSearch } from './Icons'
import { Modal } from './Modal'
import { SettingsApps } from './SettingsApps'
import { SettingsBackends } from './SettingsBackends'
import { LocalExecutionControl, SettingsPermissions } from './SettingsPermissions'
import { SettingsTools } from './SettingsTools'
import { SettingsVault } from './SettingsVault'
import { UserProfileSettings } from './UserProfileSettings'
import { VoicePreferences } from './VoicePreferences'
import { DecisionReviewPreference } from './DecisionReviewPreference'
import { NotificationDelivery } from './NotificationDelivery'
import './SettingsPanel.css'

const SCALES = [80, 90, 100, 110, 125, 150] as const
const ACCENTS: Array<{ id: Settings['accent']; color: string }> = [
  { id: 'theme', color: 'var(--ob-text-tertiary)' },
  { id: 'amber', color: '#e8a33d' },
  { id: 'blue', color: '#3b82f6' },
  { id: 'purple', color: '#8b7cf7' },
  { id: 'pink', color: '#e07aa8' },
  { id: 'green', color: '#3fa266' },
  { id: 'slate', color: '#94a3b8' },
  { id: 'orange', color: '#e08a3c' },
  { id: 'red', color: '#e34671' }
]

function Switch({ on, label, onChange, disabled = false }: { on: boolean; label: string; onChange: (next: boolean) => void; disabled?: boolean }): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      className={`ob-switch${on ? ' is-on' : ''}`}
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    />
  )
}

function Card({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="ob-set-card">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }): ReactNode {
  return (
    <div className="ob-set-row">
      <div className="ob-set-row-text">
        <div className="ob-set-row-title">{title}</div>
        {hint ? <p>{hint}</p> : null}
      </div>
      <div className="ob-set-row-control">{children}</div>
    </div>
  )
}

function General({ settings }: { settings: Settings }): ReactNode {
  const copy = useSettingsCopy()
  const g = copy.general
  const zh = resolveSettingsLang(settings.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'
  const [runner, setRunner] = useState<Awaited<ReturnType<typeof window.openbot.routines.backgroundStatus>> | null>(null)
  useEffect(() => {
    let active = true
    const refresh = (): void => { void window.openbot.routines.backgroundStatus().then((value) => { if (active) setRunner(value) }).catch(() => { if (active) setRunner({ state: 'error', error: 'Unable to read background status.' }) }) }
    refresh(); const timer = setInterval(refresh, 5000)
    return () => { active = false; clearInterval(timer) }
  }, [settings.runRoutinesWhenClosed])
  const runnerText = runner?.state === 'active' ? (zh ? '后台运行已注册。' : 'Background runner registered.') : runner?.state === 'error' ? `${zh ? '后台不可用' : 'Background unavailable'}: ${runner.error ?? ''}` : runner?.state === 'unavailable' ? (zh ? '此构建不注册后台任务。' : 'This build does not register background jobs.') : (zh ? '关闭或没有自动例程时不会注册后台任务。' : 'No background job is registered when disabled or no automatic routines exist.')
  return (
    <div className="ob-set-stack">
      <Card title={zh ? '智能工作' : 'Intelligent work'}><DecisionReviewPreference enabled={settings.decisionSkillReview === true} zh={zh} /></Card>
      <Card title={zh ? '局域网共享' : 'Local network sharing'}>
        <Row title={zh ? '远程连接与共享' : 'Remote access and sharing'} hint={zh ? '在同一 Wi-Fi 连接设备，由主机明确批准工作区访问范围和查看或操作权限。' : 'Connect devices on the same Wi-Fi, with explicit host approval of workspace scope and viewing or control permissions.'}>
          <button type="button" className="ob-btn ob-btn-sm" data-open-rooms onClick={() => store.setModal('rooms')}>{zh ? '打开' : 'Open'}</button>
        </Row>
      </Card>
      <Card title={g.appearance}>
        <Row title={g.theme} hint={g.themeHint}>
          <div className="ob-mode" role="group" aria-label={g.theme}>
            {([
              ['system', g.system],
              ['light', g.light],
              ['dark', g.dark]
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`ob-mode-btn${settings.theme === id ? ' is-active' : ''}`}
                data-theme-choice={id}
                aria-pressed={settings.theme === id}
                onClick={() => void updateSettings({ theme: id })}
              >
                {label}
              </button>
            ))}
          </div>
        </Row>
        <Row title={zh ? '原生液态玻璃' : 'Native Liquid Glass'} hint={zh ? '在支持的 macOS 上使用系统原生侧栏材质。旧版系统、减少透明度或高对比度时使用不透明界面。远程浏览器使用清晰的不透明界面。' : 'Native macOS sidebar material, with an opaque fallback on older systems and accessibility settings. Remote browsers use opaque surfaces.'}>
          <Switch on={settings.nativeGlass !== false} label={zh ? '原生液态玻璃' : 'Native Liquid Glass'} onChange={nativeGlass => void updateSettings({ nativeGlass })} />
        </Row>
        <Row title={g.language} hint={g.languageHint}>
          <select
            className="ob-select ob-settings-select"
            aria-label={g.language}
            value={settings.language}
            onChange={(e) => void updateSettings({ language: e.target.value as Settings['language'] })}
          >
            <option value="zh-CN">简体中文</option>
            <option value="en">English</option>
            <option value="system">{g.followSystem}</option>
          </select>
        </Row>
        <VoicePreferences settings={settings} zh={zh} />
        <Row title={g.scale} hint={g.scaleHint}>
          <select
            className="ob-select ob-settings-select"
            aria-label={g.scale}
            value={settings.uiScale}
            onChange={(e) => void updateSettings({ uiScale: Number(e.target.value) as Settings['uiScale'] })}
          >
            {SCALES.map((scale) => (
              <option key={scale} value={scale}>
                {scale}%
              </option>
            ))}
          </select>
        </Row>
        <Row title={g.accent} hint={g.accentHint}>
          <div className="ob-swatches" role="group" aria-label={g.accent}>
            {ACCENTS.map((swatch) => (
              <button
                key={swatch.id}
                type="button"
                className={`ob-swatch${settings.accent === swatch.id ? ' is-on' : ''}`}
                style={{ background: swatch.color }}
                aria-label={swatch.id === 'theme' ? g.accentTheme : swatch.id}
                aria-pressed={settings.accent === swatch.id}
                onClick={() => void updateSettings({ accent: swatch.id })}
              />
            ))}
          </div>
        </Row>
      </Card>
      <Card title={g.conversation}>
        <Row title={g.send} hint={g.sendHint}>
          <select
            className="ob-select ob-settings-select"
            aria-label={g.send}
            value={settings.sendShortcut}
            onChange={(e) => void updateSettings({ sendShortcut: e.target.value as Settings['sendShortcut'] })}
          >
            <option value="enter">{g.sendEnter}</option>
            <option value="mod-enter">{g.sendMod}</option>
          </select>
        </Row>
        <Row title={g.links} hint={g.linksHint}>
          <select
            className="ob-select ob-settings-select"
            aria-label={g.links}
            value={settings.linkOpen}
            onChange={(e) => void updateSettings({ linkOpen: e.target.value as Settings['linkOpen'] })}
          >
            <option value="browser">{g.linksBrowser}</option>
            <option value="window">{g.linksWindow}</option>
          </select>
        </Row>
      </Card>
      <LocalExecutionControl settings={settings} />
      <Card title={g.behavior}>
        <Row title={g.login} hint={g.loginHint}>
          <Switch
            on={settings.launchAtLogin === true}
            label={g.login}
            onChange={(launchAtLogin) => void updateSettings({ launchAtLogin })}
          />
        </Row>
        {typeof navigator === 'undefined' || navigator.platform.toLowerCase().includes('mac') ? <Row title={zh ? '关闭应用后运行例程和渠道' : 'Run routines and channels when closed'} hint={`${zh ? 'Mac 需保持唤醒且账户已登录。' : 'The Mac must be awake and your account signed in. '}${runnerText}`}>
          <Switch on={settings.runRoutinesWhenClosed !== false} label={zh ? '关闭应用后运行例程和渠道' : 'Run routines and channels when closed'} onChange={(runRoutinesWhenClosed) => void updateSettings({ runRoutinesWhenClosed })} />
        </Row> : null}
        {typeof navigator === 'undefined' || !navigator.platform.toLowerCase().includes('mac') ? <Row title={g.background} hint={g.backgroundHint}>
          <Switch
            on={settings.runInBackground === true}
            label={g.background}
            onChange={(runInBackground) => void updateSettings({ runInBackground })}
          />
        </Row> : null}
      </Card>
    </div>
  )
}

function saveDefaultThinking(value: string): void {
  void updateSettings({ defaultThinking: (value || '') as ThinkingDepth })
}

function Bots({ settings }: { settings: Settings }): ReactNode {
  const copy = useSettingsCopy()
  const { backends } = useAppState()
  const b = copy.bots
  const zh = resolveSettingsLang(settings.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'
  const modes: AgentMode[] = ['agent', 'ask', 'plan']
  const chosen = backends.find((item) => item.id === settings.defaultBackendId)
  // Catalog aliases plus whatever this CLI or provider just reported, so the
  // list follows the selected row instead of a single hardcoded "default".
  const models = runtimeModels(settings.defaultBackendId, chosen?.models ?? [], settings.defaultModelId)
  const showDefaultThinking = thinkingWire(settings.defaultBackendId) !== null
  const depths = thinkingOptions(settings.defaultBackendId, settings.defaultModelId, chosen?.models ?? [], settings.backends[settings.defaultBackendId]?.defaultModelId)
  const depthLabels: Record<ThinkingDepth, string> = { off: b.thinkingOff, low: b.thinkingLow, medium: b.thinkingMedium, high: b.thinkingHigh, xhigh: b.thinkingXHigh, max: b.thinkingMax, ultra: b.thinkingUltra }
  return (
    <div className="ob-set-stack">
    <Card title={copy.nav.bots}>
      <Row title={b.mode} hint={b.modeHint}>
        <select
          className="ob-select ob-settings-select"
          aria-label={b.mode}
          value={settings.defaultMode}
          onChange={(e) => void updateSettings({ defaultMode: e.target.value as AgentMode })}
        >
          {modes.map((mode) => (
            <option key={mode} value={mode}>
              {mode === 'agent' ? b.modeAgent : mode === 'ask' ? b.modeAsk : b.modePlan}
            </option>
          ))}
        </select>
      </Row>
      <div className="ob-set-default-models" role="group" aria-label={zh ? '默认模型' : 'Default model'}>
        <label><span className="ob-sr-only">{b.backend}</span>
        <select
          className="ob-select ob-settings-select"
          aria-label={b.backend}
          value={settings.defaultBackendId}
          onChange={(e) => {
            const defaultBackendId = e.target.value
            const defaultModelId = settings.backends[defaultBackendId]?.defaultModelId || 'default'
            void updateSettings({
              defaultBackendId,
              defaultModelId,
              defaultThinking: '' as ThinkingDepth
            })
          }}
        >
          {(backends.length > 0
            ? listedBackends(backends, settings.backends, settings.defaultBackendId).map((item) => ({
                id: item.id,
                label: item.label
              }))
            : [{ id: settings.defaultBackendId, label: settings.defaultBackendId }]
          ).map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label><span className="ob-sr-only">{b.model}</span>
        <select
          className="ob-select ob-settings-select"
          aria-label={b.model}
          value={models.some((model) => model.id === settings.defaultModelId) ? settings.defaultModelId : 'default'}
          onChange={(e) => {
            const defaultModelId = e.target.value
            const id = settings.defaultBackendId
            void updateSettings({
              defaultModelId,
              defaultThinking: settings.defaultThinking && thinkingOptions(id, defaultModelId, chosen?.models ?? [], defaultModelId).includes(settings.defaultThinking) ? settings.defaultThinking : ('' as ThinkingDepth)
            })
          }}
        >
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.id === 'default' ? b.runtimeModelDefault : model.label}
            </option>
          ))}
        </select>
      </label>
      {showDefaultThinking ? (
        <label><span className="ob-sr-only">{b.thinking}</span>
          <select
            className="ob-select ob-settings-select"
            aria-label={b.thinking}
            value={settings.defaultThinking ?? ''}
            onChange={(e) => saveDefaultThinking(e.target.value)}
          >
            <option value="">{b.thinkingDefault}</option>
            {settings.defaultThinking && !depths.includes(settings.defaultThinking) ? <option value={settings.defaultThinking} disabled>{depthLabels[settings.defaultThinking]}</option> : null}
            {depths.map((depth) => <option key={depth} value={depth}>{depthLabels[depth]}</option>)}
          </select>
        </label>
      ) : null}
      </div>
      <p className="ob-hint">{b.backendHint}</p>
    </Card>

    </div>
  )
}

function Notifications({ settings }: { settings: Settings }): ReactNode {
  const copy = useSettingsCopy()
  const n = copy.notifications
  const zh = resolveSettingsLang(settings.language, navigator.language) === 'zh-CN'
  return (
    <Card title={copy.nav.notifications}>
      <Row title={n.desktop} hint={n.desktopHint}>
        <Switch
          on={settings.notifications !== false}
          label={n.desktop}
          onChange={(notifications) => void updateSettings({ notifications })}
        />
      </Row>
      <Row title={n.turn} hint={n.turnHint}>
        <Switch
          on={settings.notifyOnTurn === true}
          label={n.turn}
          disabled={settings.notifications === false}
          onChange={(notifyOnTurn) => void updateSettings({ notifyOnTurn })}
        />
      </Row>
      <NotificationDelivery zh={zh} />
    </Card>
  )
}

function Updates({ settings }: { settings: Settings }): ReactNode {
  const copy = useSettingsCopy()
  const u = copy.updates
  const [version, setVersion] = useState('')
  const [report, setReport] = useState<UpdateReport | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void window.openbot.updates.version().then(setVersion).catch(() => setVersion(''))
  }, [])
  return (
    <Card title={copy.nav.updates}>
      <Row title={u.version}>
        <span className="ob-set-value">{version || '…'}</span>
      </Row>
      <Row title={u.channel} hint={u.channelHint}>
        <select
          className="ob-select ob-settings-select"
          aria-label={u.channel}
          value={settings.updateChannel}
          onChange={(e) => void updateSettings({ updateChannel: e.target.value as Settings['updateChannel'] })}
        >
          <option value="stable">{u.stable}</option>
          <option value="beta">{u.beta}</option>
        </select>
      </Row>
      <Row title={u.check} hint={u.hint}>
        <button
          type="button"
          className="ob-btn ob-btn-sm"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void window.openbot.updates
              .check(settings.updateChannel)
              .then(setReport)
              .finally(() => setBusy(false))
          }}
        >
          {busy ? u.checking : u.check}
        </button>
      </Row>
      {report ? (
        <p className="ob-hint" role="status">
          {updateStatusText(report, u)}
          {report.updateAvailable && report.url ? (
            <>
              {' '}
              <button
                type="button"
                className="ob-btn ob-btn-sm"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  void window.openbot.updates
                    .check(settings.updateChannel)
                    .then(setReport)
                    .finally(() => setBusy(false))
                }}
              >
                {report.installable ? u.install : u.open}
              </button>
            </>
          ) : null}
        </p>
      ) : null}
    </Card>
  )
}

function About(): ReactNode {
  const copy = useSettingsCopy()
  const a = copy.about
  const [version, setVersion] = useState('')
  useEffect(() => {
    void window.openbot.updates.version().then(setVersion).catch(() => setVersion(''))
  }, [])
  const open = (url: string): void => {
    void window.openbot.updates.openRelease(url)
  }
  return (
    <Card title={copy.nav.about}>
      <p className="ob-set-about">{a.blurb}</p>
      <p className="ob-set-value">BlinkyBot {version}</p>
      <div className="ob-set-about-actions">
        <button type="button" className="ob-btn ob-btn-sm" onClick={() => open('https://github.com/harrisliangsu/blinky-bot/blob/main/LICENSE')}>
          {a.license}
        </button>
        <button type="button" className="ob-btn ob-btn-sm" onClick={() => open('https://github.com/harrisliangsu/blinky-bot')}>
          {a.source}
        </button>
      </div>
      <p className="ob-hint">{a.credits}</p>
    </Card>
  )
}

/** Preferences. Every change saves immediately. */
export function SettingsPanel(): ReactNode {
  const copy = useSettingsCopy()
  const { settings, settingsError, backends, backendsLoading, backendsError } = useAppState()
  const [section, setSection] = useState<SettingsSection>(() => takeSettingsTab())
  const scrollRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const visible = useMemo<SettingsSection[]>(() => {
    const q = query.trim().toLowerCase()
    const settingsSections: SettingsSection[] = SETTINGS_SECTIONS.filter((id) => id !== 'apps' && id !== 'tools')
    if (!q) return settingsSections
    return settingsSections.filter((id) => {
      const blob = JSON.stringify({ name: copy.nav[id], body: id === 'vault' ? 'password card address 密码 银行卡 地址' : copy[id] }).toLowerCase()
      return blob.includes(q)
    })
  }, [copy, query])
  const current = visible.includes(section) ? section : visible[0]
  useLayoutEffect(() => {
    if (!current) return
    rememberSettingsSection(current)
    const main = scrollRef.current, body = main?.closest<HTMLElement>('.ob-modal-body')
    if (main) main.scrollTop = settingsScroll(current)
    if (body) body.scrollTop = settingsScroll(current, 'body')
    const rememberBody = (): void => { if (body) saveSettingsScroll(current, body.scrollTop, 'body') }
    body?.addEventListener('scroll', rememberBody)
    return () => body?.removeEventListener('scroll', rememberBody)
  }, [current])
  useEffect(() => {
    const deepLink = (): void => setSection(takeSettingsTab())
    window.addEventListener('openbot:settings-tab', deepLink)
    return () => window.removeEventListener('openbot:settings-tab', deepLink)
  }, [])

  const lang = resolveSettingsLang(settings?.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language)
  const groups: Array<{ label: string; sections: SettingsSection[] }> = [
    { label: lang === 'zh-CN' ? '偏好设置' : 'Preferences', sections: ['general', 'bots', 'profile', 'notifications', 'permissions'] },
    { label: lang === 'zh-CN' ? '连接' : 'Connections', sections: ['backends', 'vault'] },
    { label: lang === 'zh-CN' ? '本应用' : 'Application', sections: ['updates', 'about'] }
  ]

  // Apps and tools are workspaces opened from the account menu, not settings
  // categories. Existing deep links (including the legacy MCP link) continue
  // to land here, without adding duplicate entries to the settings sidebar.
  if (section === 'apps' || section === 'tools') {
    return (
      <Modal title={copy.nav[section]} size="lg" onClose={() => store.setModal(null)}>
        {settings ? (
          <div className="ob-set-workspace" data-settings-section={section}>
            {section === 'apps' ? <SettingsApps /> : <SettingsTools settings={settings} />}
          </div>
        ) : (
          <div className="ob-empty">
            <p>{settingsError ?? '…'}</p>
            {settingsError ? <button type="button" className="ob-btn ob-btn-sm" onClick={() => void loadSettings()}>OK</button> : null}
          </div>
        )}
      </Modal>
    )
  }

  return (
    <Modal title={copy.title} subtitle={copy.subtitle} size="lg" onClose={() => store.setModal(null)}>
      {!settings ? (
        <div className="ob-empty">
          <p>{settingsError ?? '…'}</p>
          {settingsError ? (
            <button type="button" className="ob-btn ob-btn-sm" onClick={() => void loadSettings()}>
              OK
            </button>
          ) : null}
        </div>
      ) : (
        <div className="ob-set">
          <aside className="ob-set-nav" aria-label={copy.title}>
            <label className="ob-set-search">
              <span className="ob-sr-only">{copy.search}</span>
              <IconSearch size={15} />
              <input
                type="search"
                value={query}
                placeholder={copy.search}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <select className="ob-set-mobile-picker ob-select" aria-label={lang === 'zh-CN' ? '设置分类' : 'Settings category'} value={current ?? ''} disabled={!current} onChange={event => setSection(event.target.value as SettingsSection)}>
              {!current ? <option value="">{lang === 'zh-CN' ? '没有匹配的设置' : 'No matching settings'}</option> : null}
              {visible.map(id => <option key={id} value={id}>{copy.nav[id]}</option>)}
            </select>
            <nav aria-label={copy.title} className="ob-set-nav-groups">
              {groups.map((group) => {
                const items = group.sections.filter((id) => visible.includes(id))
                return items.length ? (
                  <div className="ob-set-nav-group" key={group.label}>
                    <div className="ob-set-nav-group-label">{group.label}</div>
                    {items.map((id) => (
                      <button
                        key={id}
                        type="button"
                        id={`ob-set-tab-${id}`}
                        aria-current={current === id ? 'page' : undefined}
                        className={`ob-set-nav-btn${current === id ? ' is-on' : ''}`}
                        onClick={() => setSection(id)}
                      >
                        {copy.nav[id]}
                      </button>
                    ))}
                  </div>
                ) : null
              })}
            </nav>
          </aside>
          {current ? <div ref={scrollRef} onScroll={e => saveSettingsScroll(current, e.currentTarget.scrollTop)} className="ob-set-main" id={`ob-set-panel-${current}`} aria-labelledby={`ob-set-tab-${current}`} data-settings-section={current}>
            <header className="ob-set-page-head"><h2>{copy.nav[current]}</h2>{current === 'backends' ? <p className="ob-hint">{lang === 'zh-CN' ? '本地 Agent 以已安装的 CLI 为载体，云端 Agent 以 API Key 连接（API Key 对接完善中）。这里的 Agent 指运行载体，与 Bot 委派任务的执行 Agent 不同。' : 'Local Agents run on the CLIs you installed; cloud Agents connect via API Key (API Key onboarding is in progress). Agents here are runtimes, not the execution Agent a Bot delegates to.'}</p> : null}</header>
            {current === 'general' ? <General settings={settings} /> : null}
            {current === 'bots' ? <Bots settings={settings} /> : null}
            {current === 'profile' ? <UserProfileSettings settings={settings} /> : null}
            {current === 'notifications' ? <Notifications settings={settings} /> : null}
            {current === 'permissions' ? <SettingsPermissions settings={settings} /> : null}
            {current === 'backends' ? (
              <SettingsBackends settings={settings} backends={backends} loading={backendsLoading} error={backendsError} />
            ) : null}
            {current === 'vault' ? <SettingsVault zh={lang === 'zh-CN'} /> : null}
            {current === 'updates' ? <Updates settings={settings} /> : null}
            {current === 'about' ? <About /> : null}
          </div> : (
            <div className="ob-set-empty" role="status">
              <IconSearch size={20} />
              <strong>{lang === 'zh-CN' ? '没有找到相关设置' : 'No matching settings'}</strong>
              <span>{lang === 'zh-CN' ? '试试其他关键词。' : 'Try a different search.'}</span>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
