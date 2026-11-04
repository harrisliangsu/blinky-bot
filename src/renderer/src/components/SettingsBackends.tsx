import { useEffect, useState, type ReactNode } from 'react'
import {
  backendFieldPlan,
  cliIsUsable,
  listedBackends,
  orderedBackendSections,
  type BackendSectionId
} from '../../../shared/backendSections'
import { CLI_CATALOG, cliById } from '../../../shared/cliCatalog'
import { CLI_SLASH_LOGIN_IDS, type CliAuthState } from '../../../shared/cliAuth'
import { filterCatalog, PROVIDER_CATALOG } from '../../../shared/providerCatalog'
import type { BackendConfig, BackendInfo, Settings } from '../../../shared/types'
import { localizeBackendDetail } from '../lib/backendDetail'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { loadBackends, loginBackend, recheckBackend, store, updateSettings } from '../state'
import { IconPlus, IconRefresh, IconSpinner } from './Icons'
import './SettingsBackends.css'

/** Codex → Cx. First and last letter, so the chip stays two characters. */
function backendMark(label: string): string {
  const letters = [...label].filter((char) => /[A-Za-z0-9]/.test(char))
  if (letters.length === 0) return '•'
  if (letters.length === 1) return letters[0].toUpperCase()
  return `${letters[0]}${letters[letters.length - 1]}`.toUpperCase()
}

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
  const [sheet, setSheet] = useState<BackendSectionId | null>(null)
  const [catalogQuery, setCatalogQuery] = useState('')
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [loginOpen, setLoginOpen] = useState<Record<string, boolean>>({})
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({})
  const [managing, setManaging] = useState<Record<string, boolean>>({})

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
  const listedIds = new Set(listed.map((row) => row.id))
  const providerChoices = filterCatalog(PROVIDER_CATALOG, sheet === 'provider' ? catalogQuery : '').filter(
    (item) => !listedIds.has(item.id)
  )
  const cliChoices = filterCatalog(CLI_CATALOG, sheet === 'cli' ? catalogQuery : '').filter((item) => !listedIds.has(item.id))
  const openSheet = (next: BackendSectionId): void => {
    setCatalogQuery('')
    setSheet((current) => (current === next ? null : next))
  }
  const modelChoices = (backend: BackendInfo): Array<{ id: string; label: string }> => {
    const seen = new Set<string>()
    const out: Array<{ id: string; label: string }> = []
    const push = (id: string, label: string): void => {
      if (!id || seen.has(id)) return
      seen.add(id)
      out.push({ id, label: id === 'default' ? copy.cliDefaultModel : label })
    }
    push('default', copy.cliDefaultModel)
    for (const model of cliById(backend.id)?.models ?? []) push(model.id, model.label)
    for (const model of backend.models) push(model.id, model.label || model.id)
    return out
  }
  const sections = orderedBackendSections(listed)
  const heading: Record<BackendSectionId, string> = {
    provider: copy.providers,
    cli: copy.localCli
  }

  const renderRow = (backend: BackendInfo): ReactNode => {
    const config: BackendConfig = settings.backends[backend.id] ?? { enabled: true }
    const plan = backendFieldPlan(backend, config.hasApiKey === true)
    const show = revealed[backend.id] === true
    const keyDraft = keyDrafts[backend.id] ?? ''
    const auth = backend.kind === 'agent-cli' ? backend.cliAuth : undefined
    const authTone = auth ? AUTH_TONE[auth.state] : STATUS_TONE[backend.status]
    const busy = rowBusy[backend.id] === true
    const open = managing[backend.id] === true
    const subtitle =
      auth?.state === 'logged-in'
        ? auth.account
          ? `${auth.account} · ${copy.usable}`
          : copy.usable
        : auth
          ? copy.cliAuth[auth.state]
          : copy.status[backend.status]
    const pill = auth ? copy.cliAuth[auth.state] : copy.status[backend.status]
    return (
      <li key={backend.id} className="ob-backend-row" data-backend-id={backend.id} data-cli-auth={auth?.state ?? ''}>
        <div className="ob-backend-summary">
          <span className="ob-backend-mark" aria-hidden="true">
            {backendMark(backend.label)}
          </span>
          <div className="ob-backend-identity">
            <div className="ob-backend-titleline">
              <span className="ob-backend-name">{backend.label}</span>
              <span className={`ob-pill ${authTone}`}>{pill}</span>
              {settings.defaultBackendId === backend.id ? <span className="ob-pill">{copy.isDefault}</span> : null}
            </div>
            <p className="ob-backend-sub">{subtitle}</p>
          </div>
          <div className="ob-backend-summary-actions">
            {backend.kind === 'agent-cli' && auth?.state === 'logged-out' ? (
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
              aria-expanded={open}
              data-manage-backend={backend.id}
              onClick={() => setManaging((current) => ({ ...current, [backend.id]: !open }))}
            >
              {copy.manage}
            </button>
          </div>
        </div>
        {backend.kind === 'agent-cli' && auth?.state === 'logged-out' && CLI_SLASH_LOGIN_IDS.includes(backend.id) ? (
          <p className="ob-hint">{copy.slashLoginHint}</p>
        ) : null}
        {loginOpen[backend.id] ? <p className="ob-hint">{copy.loginPending}</p> : null}

        {open ? (
          <>
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

        <div className="ob-backend-actions">
          <label className="ob-check">
            <input
              type="checkbox"
              checked={config.enabled}
              aria-label={backend.label}
              onChange={(e) => write(backend.id, { enabled: e.target.checked })}
            />
          </label>
          {backend.kind === 'agent-cli' ? (
            <>
            <label className="ob-cli-model">
              <span>{copy.defaultModel}</span>
              <select
                className="ob-select"
                aria-label={`${backend.label} ${copy.defaultModel}`}
                data-cli-model={backend.id}
                value={config.defaultModelId || 'default'}
                onChange={(e) => {
                  const defaultModelId = e.target.value
                  void updateSettings({
                    backends: { ...settings.backends, [backend.id]: { ...config, defaultModelId } },
                    ...(settings.defaultBackendId === backend.id ? { defaultModelId } : {})
                  })
                }}
              >
                {modelChoices(backend).map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
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
            {config.added === true && !cliIsUsable(backend) ? (
              <button
                type="button"
                className="ob-btn ob-btn-sm"
                data-remove-cli={backend.id}
                onClick={() => write(backend.id, { added: false })}
              >
                {copy.removeProvider}
              </button>
            ) : null}
            </>
          ) : confirmRemove === backend.id ? (
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
          </>
        ) : null}
      </li>
    )
  }

  const refreshButton = (): ReactNode => (
    <button type="button" className="ob-btn ob-btn-sm" onClick={() => void loadBackends(true)} disabled={loading}>
      {loading ? <IconSpinner size={12} /> : <IconRefresh size={12} />}
      {copy.refresh}
    </button>
  )

  return (
    <section className="ob-settings-section">
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
            const emptyTitle = section.id === 'provider' ? copy.providersEmpty : copy.cliEmpty
            return (
              <section
                key={section.id}
                className="ob-backend-card"
                data-backend-group={section.id}
                aria-labelledby={`ob-backend-group-${section.id}`}
              >
                <div className="ob-backend-card-head">
                  <h4 id={`ob-backend-group-${section.id}`} className="ob-backend-group-title">
                    {text}
                  </h4>
                  <div className="ob-backend-card-actions">
                    {refreshButton()}
                    {section.id === 'provider' ? (
                      <button
                        type="button"
                        className="ob-btn ob-btn-sm ob-btn-primary"
                        data-add-provider=""
                        aria-expanded={sheet === 'provider'}
                        disabled={providerChoices.length === 0 && sheet !== 'provider'}
                        title={providerChoices.length === 0 ? copy.addProviderDone : undefined}
                        onClick={() => openSheet('provider')}
                      >
                        {copy.addProvider}
                      </button>
                    ) : null}
                  </div>
                </div>
                {sheet === section.id ? (
                  <div className="ob-catalog" data-catalog={section.id}>
                    <input
                      type="search"
                      className="ob-input"
                      data-catalog-search={section.id}
                      value={catalogQuery}
                      placeholder={copy.searchCatalog}
                      aria-label={copy.searchCatalog}
                      onChange={(e) => setCatalogQuery(e.target.value)}
                    />
                    {(section.id === 'provider' ? providerChoices : cliChoices).length === 0 ? (
                      <p className="ob-hint">{copy.catalogEmpty}</p>
                    ) : (
                      <ul className="ob-catalog-list" role="listbox" aria-label={section.id === 'provider' ? copy.addProvider : copy.addCli}>
                        {(section.id === 'provider' ? providerChoices : cliChoices).map((item) => (
                          <li key={item.id}>
                            <button
                              type="button"
                              className="ob-catalog-choice"
                              data-provider-choice={section.id === 'provider' ? item.id : undefined}
                              data-cli-choice={section.id === 'cli' ? item.id : undefined}
                              onClick={() => {
                                write(item.id, { added: true, enabled: true })
                                setSheet(null)
                                void recheckBackend(item.id)
                              }}
                            >
                              <strong>{item.label}</strong>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
                {section.items.length === 0 ? (
                  <div className="ob-backend-empty">
                    <span className="ob-backend-empty-mark" aria-hidden="true">
                      <IconPlus size={16} />
                    </span>
                    <p className="ob-backend-empty-title">{emptyTitle}</p>
                    {section.id === 'provider' ? <p className="ob-backend-empty-hint">{copy.providersEmptyHint}</p> : null}
                  </div>
                ) : (
                  <ul className="ob-backends">{section.items.map(renderRow)}</ul>
                )}
                {section.id === 'cli' ? (
                  <div className="ob-backend-card-foot">
                    <button
                      type="button"
                      className="ob-btn ob-btn-sm ob-btn-primary"
                      data-add-cli=""
                      aria-expanded={sheet === 'cli'}
                      disabled={cliChoices.length === 0 && sheet !== 'cli'}
                      title={cliChoices.length === 0 ? copy.addCliDone : undefined}
                      onClick={() => openSheet('cli')}
                    >
                      {copy.addCli}
                    </button>
                  </div>
                ) : null}
              </section>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}
