import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AgentMode, Settings, UpdateReport } from '../../../shared/types'
import { takeSettingsTab } from '../lib/settingsNavigation'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { loadSettings, store, updateSettings, useAppState } from '../state'
import { Modal } from './Modal'
import { SettingsBackends } from './SettingsBackends'
import { SettingsMcp } from './SettingsMcp'
import { SettingsPermissions } from './SettingsPermissions'
import './SettingsPanel.css'

type SectionId = 'general' | 'bots' | 'profile' | 'notifications' | 'permissions' | 'backends' | 'mcp' | 'updates' | 'about'

const SECTION_IDS: SectionId[] = [
  'general',
  'bots',
  'profile',
  'notifications',
  'permissions',
  'backends',
  'mcp',
  'updates',
  'about'
]

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
const PROFILE_COLORS = ['#7c9cff', '#5ad1a5', '#e0a3ff', '#f0b429', '#f07178', '#8b95a7']
const EMOJIS = ['🙂', '✨', '🌿', '🦊', '🌙', '📚']

function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (next: boolean) => void }): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      className={`ob-switch${on ? ' is-on' : ''}`}
      aria-checked={on}
      aria-label={label}
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
  return (
    <div className="ob-set-stack">
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
                aria-pressed={settings.theme === id}
                onClick={() => void updateSettings({ theme: id })}
              >
                {label}
              </button>
            ))}
          </div>
        </Row>
        <Row title={g.vibrant} hint={g.vibrantHint}>
          <Switch on={settings.vibrant === true} label={g.vibrant} onChange={(vibrant) => void updateSettings({ vibrant })} />
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
        <Row title={g.steps} hint={g.stepsHint}>
          <Switch on={settings.expandSteps === true} label={g.steps} onChange={(expandSteps) => void updateSettings({ expandSteps })} />
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
      <Card title={g.behavior}>
        <Row title={g.login} hint={g.loginHint}>
          <Switch
            on={settings.launchAtLogin === true}
            label={g.login}
            onChange={(launchAtLogin) => void updateSettings({ launchAtLogin })}
          />
        </Row>
        <Row title={g.background} hint={g.backgroundHint}>
          <Switch
            on={settings.runInBackground === true}
            label={g.background}
            onChange={(runInBackground) => void updateSettings({ runInBackground })}
          />
        </Row>
      </Card>
      <p className="ob-settings-privacy">{g.privacy}</p>
    </div>
  )
}

function Bots({ settings }: { settings: Settings }): ReactNode {
  const copy = useSettingsCopy()
  const { backends } = useAppState()
  const b = copy.bots
  const modes: AgentMode[] = ['agent', 'ask', 'plan']
  const chosen = backends.find((item) => item.id === settings.defaultBackendId)
  const models = chosen?.models ?? []
  return (
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
              {mode}
            </option>
          ))}
        </select>
      </Row>
      <Row title={b.backend} hint={b.backendHint}>
        <select
          className="ob-select ob-settings-select"
          aria-label={b.backend}
          value={settings.defaultBackendId}
          onChange={(e) => void updateSettings({ defaultBackendId: e.target.value, defaultModelId: 'default' })}
        >
          {(backends.length > 0
            ? backends.map((item) => ({ id: item.id, label: item.label }))
            : [{ id: settings.defaultBackendId, label: settings.defaultBackendId }]
          ).map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </Row>
      <Row title={b.model} hint={b.modelHint}>
        <select
          className="ob-select ob-settings-select"
          aria-label={b.model}
          value={settings.defaultModelId}
          onChange={(e) => void updateSettings({ defaultModelId: e.target.value })}
        >
          <option value="default">default</option>
          {models
            .filter((model) => model.id !== 'default')
            .map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
        </select>
      </Row>
      <Row title={b.memory} hint={b.memoryHint}>
        <select
          className="ob-select ob-settings-select"
          aria-label={b.memory}
          value={settings.memoryExtraction ?? 'api'}
          onChange={(e) =>
            void updateSettings({ memoryExtraction: e.target.value as NonNullable<Settings['memoryExtraction']> })
          }
        >
          <option value="api">{b.memoryApi}</option>
          <option value="all">{b.memoryAll}</option>
          <option value="off">{b.memoryOff}</option>
        </select>
      </Row>
    </Card>
  )
}

function Profile({ settings }: { settings: Settings }): ReactNode {
  const copy = useSettingsCopy()
  const p = copy.profile
  const [name, setName] = useState<string | null>(null)
  return (
    <Card title={copy.nav.profile}>
      <Row title={p.name} hint={p.nameHint}>
        <input
          className="ob-input ob-set-input"
          aria-label={p.name}
          value={name ?? settings.profileName}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name !== null && name !== settings.profileName) void updateSettings({ profileName: name.trim() })
            setName(null)
          }}
        />
      </Row>
      <Row title={p.emoji}>
        <div className="ob-swatches" role="group" aria-label={p.emoji}>
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={`ob-emoji${settings.profileEmoji === emoji ? ' is-on' : ''}`}
              aria-pressed={settings.profileEmoji === emoji}
              onClick={() => void updateSettings({ profileEmoji: emoji })}
            >
              {emoji}
            </button>
          ))}
        </div>
      </Row>
      <Row title={p.color}>
        <div className="ob-swatches" role="group" aria-label={p.color}>
          {PROFILE_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`ob-swatch${settings.profileColor === color ? ' is-on' : ''}`}
              style={{ background: color }}
              aria-label={color}
              aria-pressed={settings.profileColor === color}
              onClick={() => void updateSettings({ profileColor: color })}
            />
          ))}
        </div>
      </Row>
      <div className="ob-profile-preview">
        <span className="ob-profile-avatar" style={{ background: settings.profileColor }} aria-hidden="true">
          {settings.profileEmoji}
        </span>
        <span>{settings.profileName || p.preview}</span>
      </div>
    </Card>
  )
}

function Notifications({ settings }: { settings: Settings }): ReactNode {
  const copy = useSettingsCopy()
  const n = copy.notifications
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
          onChange={(notifyOnTurn) => void updateSettings({ notifyOnTurn })}
        />
      </Row>
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
          {report.note}
          {report.updateAvailable && report.url ? (
            <>
              {' '}
              <button type="button" className="ob-btn ob-btn-sm" onClick={() => void window.openbot.updates.openRelease(report.url!)}>
                {u.open}
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
  const [section, setSection] = useState<SectionId>(() => {
    const tab = takeSettingsTab()
    return tab === 'backends' || tab === 'mcp' || tab === 'permissions' || tab === 'general' ? tab : 'general'
  })
  const [query, setQuery] = useState('')
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return SECTION_IDS
    return SECTION_IDS.filter((id) => {
      const blob = JSON.stringify({ name: copy.nav[id], body: copy[id] }).toLowerCase()
      return blob.includes(q)
    })
  }, [copy, query])
  const current = visible.includes(section) ? section : visible[0] ?? 'general'

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
              <input
                type="search"
                value={query}
                placeholder={copy.search}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div role="tablist">
              {visible.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`ob-set-tab-${id}`}
                  aria-selected={current === id}
                  className={`ob-set-nav-btn${current === id ? ' is-on' : ''}`}
                  onClick={() => setSection(id)}
                >
                  {copy.nav[id]}
                </button>
              ))}
            </div>
          </aside>
          <div className="ob-set-main" role="tabpanel" id={`ob-set-panel-${current}`} aria-labelledby={`ob-set-tab-${current}`} data-settings-section={current}>
            {current === 'general' ? <General settings={settings} /> : null}
            {current === 'bots' ? <Bots settings={settings} /> : null}
            {current === 'profile' ? <Profile settings={settings} /> : null}
            {current === 'notifications' ? <Notifications settings={settings} /> : null}
            {current === 'permissions' ? <SettingsPermissions settings={settings} /> : null}
            {current === 'backends' ? (
              <SettingsBackends settings={settings} backends={backends} loading={backendsLoading} error={backendsError} />
            ) : null}
            {current === 'mcp' ? <SettingsMcp settings={settings} /> : null}
            {current === 'updates' ? <Updates settings={settings} /> : null}
            {current === 'about' ? <About /> : null}
          </div>
        </div>
      )}
    </Modal>
  )
}
