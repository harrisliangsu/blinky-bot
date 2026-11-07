import { useRef, useState, type ReactNode } from 'react'
import { backendFieldPlan, listedBackends, orderedBackendSections, type BackendSectionId } from '../../../shared/backendSections'
import { CLI_CATALOG, cliById } from '../../../shared/cliCatalog'
import { filterCatalog, PROVIDER_CATALOG } from '../../../shared/providerCatalog'
import type { BackendConfig, BackendInfo, Settings } from '../../../shared/types'
import { thinkingOptions, thinkingWire, type ThinkingDepth } from '../../../shared/thinking'
import { localizeBackendDetail } from '../lib/backendDetail'
import { resolveSettingsLang } from '../lib/settingsCopy'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { loadBackends, loginBackend, recheckBackend, store, updateSettings } from '../state'
import { IconRefresh, IconSpinner } from './Icons'
import { Modal } from './Modal'
import { captureReturnFocus, restoreReturnFocus, type ReturnFocus } from './returnFocus'
import './SettingsBackends.css'

function backendMark(label: string): string {
  const letters = [...label].filter((char) => /[A-Za-z0-9]/.test(char))
  return letters.length > 1 ? `${letters[0]}${letters[letters.length - 1]}`.toUpperCase() : (letters[0]?.toUpperCase() ?? '•')
}

interface SettingsBackendsProps {
  settings: Settings
  backends: BackendInfo[]
  loading: boolean
  error: string | null
}

type Dialog = { kind: 'catalog'; section: BackendSectionId } | { kind: 'edit'; id: string; isNew: boolean } | null
type CustomConfig = BackendConfig & { providerName?: string; providerProtocol?: 'openai' | 'anthropic' }

function urlOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin.toLowerCase() : null
  } catch {
    return null
  }
}

/** Settings writes carry the whole backends map. Read the latest snapshot so a
 * dialog opened earlier does not overwrite another connection's changes. */
async function saveBackend(id: string, patch: Partial<BackendConfig>): Promise<boolean> {
  const current = store.getState().settings
  if (!current) return false
  await updateSettings({
    backends: { ...current.backends, [id]: { ...(current.backends[id] ?? { enabled: true }), ...patch } }
  })
  return !store.getState().settingsError
}

interface EditorProps {
  backend: BackendInfo
  config: BackendConfig
  isNew: boolean
  zh: boolean
  onClose: () => void
}

function BackendEditor({ backend, config, isNew, zh, onClose }: EditorProps): ReactNode {
  const copy = useSettingsCopy().backends
  const botCopy = useSettingsCopy().bots
  const isCustom = backend.id.startsWith('custom-')
  const customConfig = config as CustomConfig
  const plan = backendFieldPlan(backend, config.hasApiKey === true)
  const provider = PROVIDER_CATALOG.find((item) => item.id === backend.id)
  const [providerName, setProviderName] = useState(customConfig.providerName ?? '')
  const [providerProtocol, setProviderProtocol] = useState<'openai' | 'anthropic'>(customConfig.providerProtocol ?? 'openai')
  const [command, setCommand] = useState(config.command ?? '')
  const [baseUrl, setBaseUrl] = useState(config.baseUrl ?? provider?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [model, setModel] = useState(config.defaultModelId || 'default')
  // Empty values are sent as tombstones: settings updates deep-merge nested
  // maps, and simply deleting a key would resurrect the old preference.
  const [modelThinking, setModelThinking] = useState<Record<string, ThinkingDepth | ''>>(config.modelThinking ?? {})
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const models = new Map<string, string>([['default', copy.cliDefaultModel]])
  for (const item of cliById(backend.id)?.models ?? []) models.set(item.id, item.label)
  for (const item of backend.models) models.set(item.id, item.label || item.id)
  if (model && !models.has(model)) models.set(model, model)
  // In this editor selecting "default" changes the connection itself to the
  // CLI default, rather than referring to the previously saved model.
  const depths = thinkingOptions(backend.id, model, backend.models)
  const labels: Record<ThinkingDepth, string> = { off: botCopy.thinkingOff, low: botCopy.thinkingLow, medium: botCopy.thinkingMedium, high: botCopy.thinkingHigh, xhigh: botCopy.thinkingXHigh, max: botCopy.thinkingMax, ultra: botCopy.thinkingUltra }

  const save = async (): Promise<void> => {
    if (isCustom && !providerName.trim()) {
      setFailure(zh ? '请输入连接名称。' : 'Enter a connection name.')
      return
    }
    if (isCustom && !urlOrigin(baseUrl)) {
      setFailure(zh ? '请输入有效的 HTTP 或 HTTPS 服务地址。' : 'Enter a valid HTTP or HTTPS endpoint.')
      return
    }
    if (isCustom && config.hasApiKey && urlOrigin(config.baseUrl ?? '') !== urlOrigin(baseUrl) && !apiKey.trim()) {
      setFailure(zh ? '服务地址的来源已更改，请重新输入此地址的 API 密钥。' : 'The endpoint origin changed. Enter its API key again.')
      return
    }
    setBusy(true)
    setFailure(null)
    const patch: Partial<BackendConfig> = { added: true, enabled: true }
    if (isCustom) Object.assign(patch, { providerName: providerName.trim(), providerProtocol })
    if (plan.command) patch.command = command.trim()
    if (plan.baseUrl) patch.baseUrl = baseUrl.trim()
    if (apiKey.trim()) patch.apiKey = apiKey.trim()
    else if (clearKey) Object.assign(patch, { apiKey: '', clearApiKey: true })
    patch.defaultModelId = model
    patch.modelThinking = modelThinking as Record<string, ThinkingDepth>
    const saved = await saveBackend(backend.id, patch)
    if (saved) {
      onClose()
      if (isCustom) void loadBackends(true)
      else void recheckBackend(backend.id)
    } else setFailure(store.getState().settingsError || (zh ? '保存失败，请重试。' : 'Could not save. Try again.'))
    setBusy(false)
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const patch: Partial<BackendConfig> = { added: false, enabled: false }
    if (backend.kind !== 'agent-cli') Object.assign(patch, { apiKey: '', hasApiKey: false, clearApiKey: true })
    const saved = await saveBackend(backend.id, patch)
    if (saved) onClose()
    else setFailure(store.getState().settingsError || (zh ? '删除失败，请重试。' : 'Could not remove. Try again.'))
    setBusy(false)
  }

  return (
    <div className="ob-backend-dialog" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); if (!busy) onClose() } }}>
      <Modal title={`${isNew ? (zh ? '添加' : 'Add') : (zh ? '管理' : 'Manage')} ${backend.label}`} subtitle={backend.kind === 'agent-cli' ? (zh ? '本机 CLI 连接' : 'Local CLI connection') : isCustom ? (zh ? '自定义 API 连接' : 'Custom API connection') : `${provider?.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'} ${zh ? '兼容接口' : 'compatible API'}`} onClose={() => { if (!busy) onClose() }} size="md">
        <div className="ob-backend-editor">
          {backend.statusDetail && !isNew ? <p className="ob-backend-editor-note">{localizeBackendDetail(backend.statusDetail, copy.detail)}</p> : null}
          {failure ? <p role="alert" className="ob-notice ob-notice-error">{failure}</p> : null}
          {isCustom ? <><div className="ob-field"><label htmlFor="ob-provider-name">{zh ? '名称' : 'Name'}</label><input id="ob-provider-name" className="ob-input" value={providerName} onChange={(e) => setProviderName(e.target.value)} /></div><div className="ob-field"><label htmlFor="ob-provider-protocol">{zh ? '接口类型' : 'API protocol'}</label><select id="ob-provider-protocol" className="ob-select" value={providerProtocol} onChange={(e) => setProviderProtocol(e.target.value as 'openai' | 'anthropic')}><option value="openai">OpenAI compatible</option><option value="anthropic">Anthropic compatible</option></select></div></> : null}
          {plan.command ? <div className="ob-field"><label htmlFor={`ob-cmd-${backend.id}`}>{copy.command}</label><input id={`ob-cmd-${backend.id}`} className="ob-input" value={command} placeholder={copy.commandPlaceholder} onChange={(e) => setCommand(e.target.value)} /></div> : null}
          {plan.baseUrl ? <div className="ob-field"><label htmlFor={`ob-url-${backend.id}`}>{copy.baseUrl}</label><input id={`ob-url-${backend.id}`} className="ob-input" value={baseUrl} placeholder={copy.baseUrlPlaceholder} onChange={(e) => setBaseUrl(e.target.value)} /></div> : null}
          {plan.apiKey ? <div className="ob-field"><label htmlFor={`ob-key-${backend.id}`}>{plan.apiKeyOptional ? copy.optionalKey : copy.apiKey}</label><div className="ob-backend-key"><input id={`ob-key-${backend.id}`} className="ob-input" type={showKey ? 'text' : 'password'} value={apiKey} autoComplete="off" spellCheck={false} placeholder={config.hasApiKey ? copy.stored : plan.apiKeyOptional ? copy.optionalKeyPlaceholder : copy.keyPlaceholder} onChange={(e) => { setApiKey(e.target.value); setClearKey(false) }} /><button type="button" className="ob-btn ob-btn-sm" aria-pressed={showKey} onClick={() => setShowKey(!showKey)}>{showKey ? copy.hide : copy.show}</button></div>{config.hasApiKey ? <label className="ob-check"><input type="checkbox" checked={clearKey} onChange={(e) => { setClearKey(e.target.checked); if (e.target.checked) setApiKey('') }} /><span>{zh ? '保存时移除已保存的密钥' : 'Remove saved key when saving'}</span></label> : null}</div> : null}
          <div className="ob-field"><label htmlFor={`ob-model-${backend.id}`}>{copy.defaultModel}</label><select id={`ob-model-${backend.id}`} className="ob-select" data-cli-model={backend.id} value={model} onChange={(e) => setModel(e.target.value)}>{Array.from(models, ([id, label]) => <option key={id} value={id}>{label}</option>)}</select></div>
          {thinkingWire(backend.id) ? <div className="ob-field"><label htmlFor={`ob-effort-${backend.id}`}>{botCopy.thinking}</label><select id={`ob-effort-${backend.id}`} className="ob-select" value={modelThinking[model] ?? ''} onChange={(e) => { const value = e.target.value as ThinkingDepth | ''; setModelThinking((previous) => ({ ...previous, [model]: value })) }}><option value="">{botCopy.thinkingDefault}</option>{modelThinking[model] && !depths.includes(modelThinking[model]) ? <option value={modelThinking[model]} disabled>{labels[modelThinking[model]]}</option> : null}{depths.map((depth) => <option key={depth} value={depth}>{labels[depth]}</option>)}</select></div> : null}
          {confirmRemove ? <div className="ob-backend-danger"><><p>{backend.kind === 'agent-cli' ? (zh ? '移除后不会卸载 CLI 或退出登录。使用此连接的 Bot 需要重新配置。' : 'This does not uninstall the CLI or log out. Bots using it need to be reconfigured.') : (zh ? '移除此连接将删除其保存的 API 密钥。使用此连接的 Bot 需要重新配置。' : 'Removing this connection deletes its saved API key. Bots using it need to be reconfigured.')}</p><div className="ob-backend-danger-actions"><button type="button" className="ob-btn ob-btn-sm" data-confirm-remove={backend.id} disabled={busy} onClick={() => void remove()}>{copy.confirmRemove}</button><button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => setConfirmRemove(false)}>{copy.cancelRemove}</button></div></></div> : null}
          <div className="ob-backend-editor-footer">{!isNew && !confirmRemove ? <button type="button" className="ob-btn" data-remove-cli={backend.kind === 'agent-cli' ? backend.id : undefined} data-remove-provider={backend.kind !== 'agent-cli' ? backend.id : undefined} onClick={() => setConfirmRemove(true)}>{copy.removeProvider}</button> : null}<button type="button" className="ob-btn" disabled={busy} onClick={onClose}>{zh ? '取消' : 'Cancel'}</button><button type="button" className="ob-btn ob-btn-primary" disabled={busy} onClick={() => void save()}>{busy ? <IconSpinner size={12} /> : null}{zh ? '保存' : 'Save'}</button></div>
        </div>
      </Modal>
    </div>
  )
}

export function SettingsBackends({ settings, backends, loading, error }: SettingsBackendsProps): ReactNode {
  const copy = useSettingsCopy().backends
  const zh = resolveSettingsLang(settings.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'
  const [dialog, setDialog] = useState<Dialog>(null)
  const returnFocus = useRef<ReturnFocus | null>(null)
  const [query, setQuery] = useState('')
  const listed = listedBackends(backends, settings.backends)
  const listedIds = new Set(listed.map((item) => item.id))
  const current = dialog?.kind === 'edit' ? backends.find((item) => item.id === dialog.id) : undefined
  const choices = dialog?.kind === 'catalog'
    ? (dialog.section === 'provider' ? filterCatalog(PROVIDER_CATALOG, query) : filterCatalog(CLI_CATALOG, query)).filter((item) => !listedIds.has(item.id))
    : []
  const openDialog = (next: NonNullable<Dialog>): void => {
    if (!dialog) returnFocus.current = captureReturnFocus()
    setDialog(next)
  }
  const openCatalog = (section: BackendSectionId): void => { setQuery(''); openDialog({ kind: 'catalog', section }) }
  const close = (): void => { setDialog(null); restoreReturnFocus(returnFocus.current); returnFocus.current = null }
  return <section className="ob-settings-section">
    {error ? <p className="ob-notice ob-notice-error" role="alert">{error}</p> : null}
    {backends.length === 0 && !loading ? <p className="ob-hint">{copy.empty}</p> : null}
    {backends.length > 0 ? <div className="ob-backend-groups">{orderedBackendSections(listed).map((section) => <section key={section.id} className="ob-backend-card" data-backend-group={section.id} aria-labelledby={`ob-backend-group-${section.id}`}>
      <div className="ob-backend-card-head"><div><h4 id={`ob-backend-group-${section.id}`} className="ob-backend-group-title">{section.id === 'provider' ? copy.providers : copy.localCli}</h4><p className="ob-backend-section-caption">{section.id === 'provider' ? (zh ? '管理 API 供应商和连接' : 'Manage API providers and connections') : (zh ? '使用已安装的命令行工具' : 'Connect installed command-line tools')}</p></div><div className="ob-backend-card-actions"><button type="button" className="ob-btn ob-btn-sm" onClick={() => void loadBackends(true)} disabled={loading}>{loading ? <IconSpinner size={12} /> : <IconRefresh size={12} />}{copy.refresh}</button><button type="button" className="ob-btn ob-btn-sm ob-btn-primary" data-add-provider={section.id === 'provider' ? '' : undefined} data-add-cli={section.id === 'cli' ? '' : undefined} onClick={() => openCatalog(section.id)}>{section.id === 'provider' ? copy.addProvider : copy.addCli}</button></div></div>
      {section.items.length === 0 ? <div className="ob-backend-empty"><p className="ob-backend-empty-title">{section.id === 'provider' ? copy.providersEmpty : copy.cliEmpty}</p>{section.id === 'provider' ? <p className="ob-backend-empty-hint">{copy.providersEmptyHint}</p> : null}</div> : <ul className="ob-backends">{section.items.map((backend) => {
        const auth = backend.kind === 'agent-cli' ? backend.cliAuth : undefined
        const status = auth ? copy.cliAuth[auth.state] : copy.status[backend.status]
        const subtitle = auth?.state === 'logged-in' && auth.account ? `${auth.account} · ${copy.usable}` : status
        const tone = auth?.state === 'logged-in' || (!auth && backend.status === 'available') ? 'ob-pill-ok' : backend.status === 'error' ? 'ob-pill-bad' : 'ob-pill-warn'
        return <li key={backend.id} className="ob-backend-row" data-backend-id={backend.id} data-cli-auth={auth?.state ?? ''}><div className="ob-backend-summary"><span className="ob-backend-mark" aria-hidden="true">{backendMark(backend.label)}</span><div className="ob-backend-identity"><div className="ob-backend-titleline"><span className="ob-backend-name">{backend.label}</span><span className={`ob-pill ${tone}`}>{status}</span>{settings.defaultBackendId === backend.id ? <span className="ob-pill">{copy.isDefault}</span> : null}</div><p className="ob-backend-sub">{subtitle}</p></div><div className="ob-backend-summary-actions">{auth?.state === 'logged-out' ? <button type="button" className="ob-btn ob-btn-sm" data-cli-login={backend.id} onClick={() => { void loginBackend(backend.id).then((started) => { if (!started) store.toast(copy.loginFailed, 'error') }) }}>{copy.login}</button> : null}<button type="button" className="ob-btn ob-btn-sm" data-manage-backend={backend.id} onClick={() => openDialog({ kind: 'edit', id: backend.id, isNew: false })}>{copy.manage}</button></div></div></li>
      })}</ul>}
    </section>)}</div> : null}
    {dialog?.kind === 'catalog' ? <div className="ob-backend-dialog" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}><Modal title={dialog.section === 'provider' ? copy.addProvider : copy.addCli} subtitle={zh ? '选择要配置的连接' : 'Choose a connection to configure'} onClose={close} size="md"><div className="ob-catalog" data-catalog={dialog.section}><input type="search" className="ob-input" data-catalog-search={dialog.section} value={query} placeholder={copy.searchCatalog} aria-label={copy.searchCatalog} onChange={(e) => setQuery(e.target.value)} />{choices.length === 0 ? <p className="ob-hint">{copy.catalogEmpty}</p> : <ul className="ob-catalog-list">{choices.map((item) => <li key={item.id}><button type="button" className="ob-catalog-choice" data-provider-choice={dialog.section === 'provider' ? item.id : undefined} data-cli-choice={dialog.section === 'cli' ? item.id : undefined} onClick={() => openDialog({ kind: 'edit', id: item.id, isNew: true })}><span className="ob-backend-mark" aria-hidden="true">{backendMark(item.label)}</span><strong>{item.label}</strong><span className="ob-catalog-arrow" aria-hidden="true">›</span></button></li>)}</ul>}</div></Modal></div> : null}
    {dialog?.kind === 'edit' && current ? <BackendEditor key={`${current.id}-${dialog.isNew}`} backend={current} config={settings.backends[current.id] ?? { enabled: true }} isNew={dialog.isNew} zh={zh} onClose={close} /> : null}
  </section>
}
