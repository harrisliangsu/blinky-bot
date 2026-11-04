import { useEffect, useState, type ReactNode } from 'react'
import { backendFieldPlan, listedBackends, orderedBackendSections, type BackendSectionId } from '../../../shared/backendSections'
import { CLI_SLASH_LOGIN_IDS, type CliAuthState } from '../../../shared/cliAuth'
import type { BackendConfig, BackendInfo, Settings } from '../../../shared/types'
import { localizeBackendDetail } from '../lib/backendDetail'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { loadBackends, loginBackend, recheckBackend, store, updateSettings } from '../state'
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

const AUTH_TONE: Record<CliAuthState, string> = {
  'logged-in': 'ob-pill-ok',
  'logged-out': 'ob-pill-warn',
  'not-installed': 'ob-pill-warn',
  unknown: ''
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
  const [picking, setPicking] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [loginOpen, setLoginOpen] = useState<Record<string, boolean>>({})
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({})

  useEffect(() => {
    setLoginOpen((current) => {
      let changed = false
      const next = { ...current }
      for (const backend of backends) {
        if (next[backend.id] && backend.cliAuth?.state === 'logged-in') {
          delete next[backend.id]
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [backends])

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

  const listed = listedBackends(backends, settings.backends)
  const availableProviders = backends.filter(
    (backend) => backend.kind !== 'agent-cli' && !listed.some((row) => row.id === backend.id)
  )
  const sections = orderedBackendSections(listed)
  const heading: Record<BackendSectionId, { title: string; hint: string; footnote?: string }> = {
    provider: { title: copy.providers, hint: copy.providersHint, footnote: copy.compatibleHint },
    cli: { title: copy.localCli, hint: copy.localCliHint }
  }

  const renderRow = (backend: BackendInfo): ReactNode => {
    const config: BackendConfig = settings.backends[backend.id] ?? { enabled: true }
    const plan = backendFieldPlan(backend, config.hasApiKey === true)
    const show = revealed[backend.id] === true
    const keyDraft = keyDrafts[backend.id] ?? ''
    const auth = backend.kind === 'agent-cli' ? backend.cliAuth : undefined
    const authLabel = auth
      ? auth.account && auth.state === 'logged-in'
        ? `${copy.cliAuth[auth.state]} · ${auth.account}`
        : copy.cliAuth[auth.state]
      : copy.status[backend.status]
    const authTone = auth ? AUTH_TONE[auth.state] : STATUS_TONE[backend.status]
    const busy = rowBusy[backend.id] === true
    return (
      <li key={backend.id} className="ob-backend" data-backend-id={backend.id} data-cli-auth={auth?.state ?? ''}>
        <div className="ob-backend-head">
          <label className="ob-check">
            <input type="checkbox" checked={config.enabled} onChange={(e) => write(backend.id, { enabled: e.target.checked })} />
            <span className="ob-backend-name">{backend.label}</span>
          </label>
          <span className="ob-backend-tags">
            <span className="ob-pill">{backend.local ? copy.local : copy.cloud}</span>
            <span className="ob-pill">{backend.toolMode} {copy.tools}</span>
            <span className={`ob-pill ${authTone}`}>{authLabel}</span>
          </span>
        </div>

        {backend.statusDetail ? <p className="ob-hint">{localizeBackendDetail(backend.statusDetail, copy.detail)}</p> : null}

        <div className={`ob-backend-fields${plan.command && !plan.baseUrl ? ' is-stack' : ''}`}>
          {plan.command ? (
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

          {plan.apiKey ? (
            <div className="ob-field">
              <label htmlFor={`ob-key-${backend.id}`}>{plan.apiKeyOptional ? copy.optionalKey : copy.apiKey}</label>
              <div className="ob-backend-key">
                <input
                  id={`ob-key-${backend.id}`}
                  className="ob-input"
                  type={show ? 'text' : 'password'}
                  value={keyDraft}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={
                    config.hasApiKey
                      ? copy.stored
                      : plan.apiKeyOptional
                        ? copy.optionalKeyPlaceholder
                        : copy.keyPlaceholder
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
          ) : null}

          {plan.baseUrl ? (
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
          ) : null}
        </div>

        {backend.kind === 'agent-cli' ? (
          <div className="ob-backend-actions">
            {auth?.state === 'logged-out' ? (
              <button
                type="button"
                className="ob-btn ob-btn-sm"
                data-cli-login={backend.id}
                onClick={() => {
                  setLoginOpen((current) => ({ ...current, [backend.id]: true }))
                  void loginBackend(backend.id).then((started) => {
                    if (!started) {
                      setLoginOpen((current) => ({ ...current, [backend.id]: false }))
                      store.toast(copy.loginFailed, 'error')
                    }
                  })
                }}
              >
                {copy.login}
              </button>
            ) : null}
            <button
              type="button"
              className="ob-btn ob-btn-sm"
              data-cli-recheck={backend.id}
              disabled={busy}
              onClick={() => {
                setRowBusy((current) => ({ ...current, [backend.id]: true }))
                void recheckBackend(backend.id).finally(() => {
                  setRowBusy((current) => ({ ...current, [backend.id]: false }))
                })
              }}
            >
              {busy ? <IconSpinner size={12} /> : null}
              {copy.recheck}
            </button>
            {auth?.state === 'logged-out' && CLI_SLASH_LOGIN_IDS.includes(backend.id) ? (
              <p className="ob-hint">{copy.slashLoginHint}</p>
            ) : null}
            {loginOpen[backend.id] ? <p className="ob-hint">{copy.loginPending}</p> : null}
          </div>
        ) : (
          <div className="ob-backend-actions">
            {confirmRemove === backend.id ? (
              <>
                <p className="ob-hint">{copy.removeProviderConfirm}</p>
                <button
                  type="button"
                  className="ob-btn ob-btn-sm"
                  data-confirm-remove={backend.id}
                  onClick={() => {
                    write(backend.id, { added: false, enabled: false, apiKey: '', hasApiKey: false, clearApiKey: true })
                    setConfirmRemove(null)
                  }}
                >
                  {copy.confirmRemove}
                </button>
                <button type="button" className="ob-btn ob-btn-sm" onClick={() => setConfirmRemove(null)}>
                  {copy.cancelRemove}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="ob-btn ob-btn-sm"
                data-remove-provider={backend.id}
                onClick={() => setConfirmRemove(backend.id)}
              >
                {copy.removeProvider}
              </button>
            )}
          </div>
        )}
      </li>
    )
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

      {backends.length === 0 && !loading ? <p className="ob-hint">{copy.empty}</p> : null}

      {backends.length > 0 ? (
        <div className="ob-backend-groups">
          {sections.map((section) => {
            const text = heading[section.id]
            return (
              <section
                key={section.id}
                className="ob-backend-group"
                data-backend-group={section.id}
                aria-labelledby={`ob-backend-group-${section.id}`}
              >
                <div className="ob-backend-group-head">
                  <div className="ob-backend-group-title-row">
                    <h4 id={`ob-backend-group-${section.id}`} className="ob-backend-group-title">
                      {text.title}
                    </h4>
                    {section.id === 'provider' ? (
                      <button
                        type="button"
                        className="ob-btn ob-btn-sm"
                        data-add-provider=""
                        aria-expanded={picking}
                        disabled={availableProviders.length === 0}
                        title={availableProviders.length === 0 ? copy.addProviderDone : undefined}
                        onClick={() => setPicking((open) => !open)}
                      >
                        {copy.addProvider}
                      </button>
                    ) : null}
                  </div>
                  <p className="ob-hint">{text.hint}</p>
                  {section.id === 'provider' && picking && availableProviders.length > 0 ? (
                    <ul className="ob-provider-picker" role="listbox" aria-label={copy.addProvider}>
                      {availableProviders.map((provider) => (
                        <li key={provider.id}>
                          <button
                            type="button"
                            className="ob-btn ob-btn-sm"
                            data-provider-choice={provider.id}
                            onClick={() => {
                              write(provider.id, { added: true, enabled: true })
                              setPicking(false)
                              void recheckBackend(provider.id)
                            }}
                          >
                            {provider.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                {section.items.length === 0 ? (
                  <p className="ob-hint">{section.id === 'provider' ? copy.providersEmpty : copy.sectionEmpty}</p>
                ) : (
                  <ul className="ob-backends">{section.items.map(renderRow)}</ul>
                )}
                {text.footnote ? <p className="ob-hint">{text.footnote}</p> : null}
              </section>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}
