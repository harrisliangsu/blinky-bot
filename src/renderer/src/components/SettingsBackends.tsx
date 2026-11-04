import { useState, type ReactNode } from 'react'
import type { BackendConfig, BackendInfo, Settings } from '../../../shared/types'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { loadBackends, updateSettings } from '../state'
import { IconRefresh, IconSpinner } from './Icons'
import './SettingsBackends.css'

interface SettingsBackendsProps {
  settings: Settings
  backends: BackendInfo[]
  loading: boolean
  error: string | null
}

const STATUS_TONE: Record<BackendInfo['status'], string> = {
  available: 'ob-pill-ok',
  'not-installed': 'ob-pill-warn',
  'not-running': 'ob-pill-warn',
  'needs-key': 'ob-pill-warn',
  error: 'ob-pill-bad'
}

/** Per-backend connection settings. Keys stay on this machine. */
export function SettingsBackends({ settings, backends, loading, error }: SettingsBackendsProps): ReactNode {
  const copy = useSettingsCopy().backends
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  /*
   * The free-text fields are typed into a draft and committed on blur, exactly
   * as the API key beside them already is.
   *
   * `write` posts the WHOLE backends map through `settings.update`, and
   * `updateSettings` serialises those writes — so a field bound straight to it
   * turned a 60-character base URL into 60 queued disk writes and a field that
   * visibly lagged behind the keyboard. `undefined` means "no draft", so the
   * saved value shows through again the moment one is committed.
   */
  const [urlDrafts, setUrlDrafts] = useState<Record<string, string | undefined>>({})
  const [commandDrafts, setCommandDrafts] = useState<Record<string, string | undefined>>({})

  const write = (id: string, patch: Partial<BackendConfig>): void => {
    const current: BackendConfig = settings.backends[id] ?? { enabled: true }
    void updateSettings({ backends: { ...settings.backends, [id]: { ...current, ...patch } } })
  }

  const commitUrl = (id: string, saved: string): void => {
    const draft = urlDrafts[id]
    if (draft !== undefined && draft !== saved) write(id, { baseUrl: draft })
    setUrlDrafts((drafts) => ({ ...drafts, [id]: undefined }))
  }

  const commitCommand = (id: string, saved: string): void => {
    const draft = commandDrafts[id]
    if (draft !== undefined && draft !== saved) write(id, { command: draft })
    setCommandDrafts((drafts) => ({ ...drafts, [id]: undefined }))
  }

  return (
    <section className="ob-settings-section">
      <header className="ob-settings-head">
        <h3 className="ob-label">{copy.title}</h3>
        <button type="button" className="ob-btn ob-btn-sm" onClick={() => void loadBackends(true)} disabled={loading}>
          {loading ? <IconSpinner size={12} /> : <IconRefresh size={12} />}
          {copy.refresh}
        </button>
      </header>

      {error ? (
        <p className="ob-notice ob-notice-error" role="alert">
          {error}
        </p>
      ) : null}

      {backends.length === 0 && !loading ? (
        <p className="ob-hint">{copy.empty}</p>
      ) : null}

      <ul className="ob-backends">
        {backends.map((backend) => {
          const config: BackendConfig = settings.backends[backend.id] ?? { enabled: true }
          const show = revealed[backend.id] === true
          const keyDraft = keyDrafts[backend.id] ?? ''
          return (
            <li key={backend.id} className="ob-backend">
              <div className="ob-backend-head">
                <label className="ob-check">
                  <input type="checkbox" checked={config.enabled} onChange={(e) => write(backend.id, { enabled: e.target.checked })} />
                  <span className="ob-backend-name">{backend.label}</span>
                </label>
                <span className="ob-backend-tags">
                  <span className="ob-pill">{backend.local ? copy.local : copy.cloud}</span>
                  <span className="ob-pill">{backend.toolMode} {copy.tools}</span>
                  <span className={`ob-pill ${STATUS_TONE[backend.status]}`}>{copy.status[backend.status]}</span>
                </span>
              </div>

              {backend.statusDetail ? <p className="ob-hint">{backend.statusDetail}</p> : null}

              <div className="ob-backend-fields">
                <div className="ob-field">
                  <label htmlFor={`ob-url-${backend.id}`}>{copy.baseUrl}</label>
                  <input
                    id={`ob-url-${backend.id}`}
                    className="ob-input"
                    value={urlDrafts[backend.id] ?? config.baseUrl ?? ''}
                    placeholder={copy.baseUrlPlaceholder}
                    onChange={(e) => setUrlDrafts((drafts) => ({ ...drafts, [backend.id]: e.target.value }))}
                    onBlur={() => commitUrl(backend.id, config.baseUrl ?? '')}
                  />
                </div>

                <div className="ob-field">
                  <label htmlFor={`ob-key-${backend.id}`}>{copy.apiKey}</label>
                  <div className="ob-backend-key">
                    <input
                      id={`ob-key-${backend.id}`}
                      className="ob-input"
                      type={show ? 'text' : 'password'}
                      value={keyDraft}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={
                        config.hasApiKey ? copy.stored : backend.local ? copy.notRequired : copy.keyPlaceholder
                      }
                      onChange={(e) => setKeyDrafts((drafts) => ({ ...drafts, [backend.id]: e.target.value }))}
                    />
                    <button
                      type="button"
                      className="ob-btn ob-btn-sm"
                      aria-pressed={show}
                      onClick={() => setRevealed((r) => ({ ...r, [backend.id]: !show }))}
                    >
                      {show ? copy.hide : copy.show}
                    </button>
                    {keyDraft.trim() ? (
                      <button
                        type="button"
                        className="ob-btn ob-btn-sm"
                        onClick={() => {
                          write(backend.id, { apiKey: keyDraft })
                          setKeyDrafts((drafts) => ({ ...drafts, [backend.id]: '' }))
                        }}
                      >
                        {copy.saveKey}
                      </button>
                    ) : null}
                    {config.hasApiKey ? (
                      <button
                        type="button"
                        className="ob-btn ob-btn-sm"
                        onClick={() => write(backend.id, { apiKey: '', clearApiKey: true })}
                      >
                        {copy.clear}
                      </button>
                    ) : null}
                  </div>
                </div>

                {backend.kind === 'agent-cli' ? (
                  <div className="ob-field">
                    <label htmlFor={`ob-cmd-${backend.id}`}>{copy.command}</label>
                    <input
                      id={`ob-cmd-${backend.id}`}
                      className="ob-input"
                      value={commandDrafts[backend.id] ?? config.command ?? ''}
                      placeholder={copy.commandPlaceholder}
                      onChange={(e) => setCommandDrafts((drafts) => ({ ...drafts, [backend.id]: e.target.value }))}
                      onBlur={() => commitCommand(backend.id, config.command ?? '')}
                    />
                  </div>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
