import { useState, type ReactNode } from 'react'
import type { AgentMode, Settings } from '../../../shared/types'
import { takeSettingsTab, type SettingsTab } from '../lib/settingsNavigation'
import { loadSettings, store, updateSettings, useAppState } from '../state'
import { Modal } from './Modal'
import { SettingsBackends } from './SettingsBackends'
import { SettingsMcp } from './SettingsMcp'
import { SettingsPermissions } from './SettingsPermissions'
import './SettingsPanel.css'

type Tab = SettingsTab

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'backends', label: 'Backends' },
  { id: 'mcp', label: 'MCP' }
]

const THEMES: Array<{ id: Settings['theme']; label: string }> = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' }
]

const MODES: AgentMode[] = ['agent', 'ask', 'plan']

/*
 * These mirror the clamp in the settings schema (`MIN_FONT_SIZE` /
 * `MAX_FONT_SIZE` in src/main/settingsSchema.ts), which is the authority on what
 * a stored font size may be. The slider ran 11–17, so a size the schema happily
 * keeps — 24, say, edited into settings.json or left by an older build — showed
 * a label reading "24px" beside a thumb pinned at the far right of a 17 scale,
 * and the first nudge silently shrank the interface. The panel is a view of the
 * schema's range, not a narrower one of its own.
 */
const MIN_FONT_SIZE = 10
const MAX_FONT_SIZE = 24

function General({ settings }: { settings: Settings }): ReactNode {
  return (
    <section className="ob-settings-section">
      <div className="ob-field">
        <span className="ob-label">Theme</span>
        <div className="ob-mode" role="group" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`ob-mode-btn${settings.theme === t.id ? ' is-active' : ''}`}
              aria-pressed={settings.theme === t.id}
              onClick={() => void updateSettings({ theme: t.id })}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="ob-field">
        <label htmlFor="ob-fontsize" className="ob-label">
          Font size — {settings.fontSize}px
        </label>
        <input
          id="ob-fontsize"
          className="ob-settings-range"
          type="range"
          min={MIN_FONT_SIZE}
          max={MAX_FONT_SIZE}
          step={1}
          value={settings.fontSize}
          onChange={(e) => void updateSettings({ fontSize: Number(e.target.value) })}
        />
        <p className="ob-hint">Scales the whole interface, not just the transcript.</p>
      </div>

      <div className="ob-field">
        <label htmlFor="ob-defaultmode" className="ob-label">
          Default mode for new chats
        </label>
        <select
          id="ob-defaultmode"
          className="ob-select ob-settings-select"
          value={settings.defaultMode}
          onChange={(e) => void updateSettings({ defaultMode: e.target.value as AgentMode })}
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <label className="ob-check">
        <input
          type="checkbox"
          checked={settings.runInBackground === true}
          onChange={(e) => void updateSettings({ runInBackground: e.target.checked })}
        />
        <span>
          Run in background
          <span className="ob-hint"> — start at login and keep scheduled routines available after the window closes.</span>
        </span>
      </label>

      <p className="ob-settings-privacy">
        No account. No telemetry. Nothing leaves this machine except calls to the model backend you configure.
      </p>
    </section>
  )
}

/** Preferences, grouped into four tabs. Every change saves immediately. */
export function SettingsPanel(): ReactNode {
  const { settings, settingsError, backends, backendsLoading, backendsError } = useAppState()
  const [tab, setTab] = useState<Tab>(() => takeSettingsTab())

  return (
    <Modal title="Settings" subtitle="Stored on this machine." size="md" onClose={() => store.setModal(null)}>
      {!settings ? (
        <div className="ob-empty">
          <p>{settingsError ?? 'Loading settings…'}</p>
          {settingsError ? (
            <button type="button" className="ob-btn ob-btn-sm" onClick={() => void loadSettings()}>
              Try again
            </button>
          ) : null}
        </div>
      ) : (
        <div className="ob-settings">
          <div className="ob-settings-tabs" role="tablist" aria-label="Settings sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`ob-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`ob-panel-${t.id}`}
                className={`ob-settings-tab${tab === t.id ? ' is-active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {settingsError ? (
            <p className="ob-notice ob-notice-error" role="alert">
              {settingsError}
            </p>
          ) : null}

          <div className="ob-settings-panel" role="tabpanel" id={`ob-panel-${tab}`} aria-labelledby={`ob-tab-${tab}`}>
            {tab === 'general' ? <General settings={settings} /> : null}
            {tab === 'permissions' ? <SettingsPermissions settings={settings} /> : null}
            {tab === 'backends' ? (
              <SettingsBackends settings={settings} backends={backends} loading={backendsLoading} error={backendsError} />
            ) : null}
            {tab === 'mcp' ? <SettingsMcp settings={settings} /> : null}
          </div>
        </div>
      )}
    </Modal>
  )
}
