import { FormDialog } from './FormDialog'
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import type { McpServerConfig, Settings } from '../../../shared/types'
import { resolveSettingsLang } from '../lib/settingsCopy'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { store, updateSettings } from '../state'
import { saveMcpServer } from '../state/preferences'
import { IconPencil, IconPlus, IconTrash } from './Icons'
import './SettingsMcp.css'

interface SettingsMcpProps {
  settings: Settings
  /** Page toolbar owns the add button; the list stays compact. */
  compact?: boolean
}

export interface McpHandle { add(): void }

const blank = (): McpServerConfig => ({
  id: `mcp-${Date.now()}`,
  name: '',
  enabled: true,
  transport: 'stdio',
  command: '',
  args: [],
  url: '',
  auth: 'none',
  accountName: '',
  disabledTools: []
})

/** MCP server list: enable, edit connection details, remove. No preset catalog. */
export const SettingsMcp = forwardRef<McpHandle, SettingsMcpProps>(function SettingsMcp({ settings, compact = false }, ref): ReactNode {
  const focusScope = useId()
  const copy = useSettingsCopy().mcp
  const zh = resolveSettingsLang(settings.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'
  const [draft, setDraft] = useState<McpServerConfig | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const servers = settings.mcpServers ?? []
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const saving = useRef(false)
  const openDraft = (): void => { if (saving.current) return; setError(''); setEditingId(null); setDraft(blank()) }
  useImperativeHandle(ref, () => ({ add: openDraft }), [])

  const write = (next: McpServerConfig[]): void => {
    void updateSettings({ mcpServers: next })
  }

  const patch = (id: string, change: Partial<McpServerConfig>): void =>
    write(servers.map((s) => (s.id === id ? { ...s, ...change } : s)))

  const closeDraft = (): void => {
    if (saving.current) return
    setError('')
    setDraft(null)
    setEditingId(null)
  }

  const saveDraft = async (): Promise<void> => {
    if (!draft || saving.current) return
    saving.current = true; setBusy(true); setError('')
    try {
      const result = await saveMcpServer({ server: draft, editingId: editingId ?? undefined })
      if (!result.ok) { setError(result.error); return }
      setDraft(null); setEditingId(null)
    } finally { saving.current = false; setBusy(false) }
  }

  /*
   * Settings are broadcast to every window, so the server this form is editing
   * can disappear from under it — the disabled Remove button below only covers
   * this window. Either way the loss used to be silent: the form stayed open
   * holding the typed data and "Save account" mapped over a list that no longer
   * held the id, writing nothing and saying nothing. Close it and say why.
   */
  useEffect(() => {
    if (editingId === null || saving.current) return
    if (servers.some((server) => server.id === editingId)) return
    closeDraft()
    store.toast(copy.removed, 'error')
  }, [editingId, servers])

  return (
    <section className="ob-settings-section" id={focusScope}>
      {compact ? null : <header className="ob-skill-toolbar">
        <h3 className="ob-label">{copy.title}</h3>
        <button type="button" data-mcp-add className="ob-btn ob-btn-sm ob-btn-primary" onClick={openDraft} disabled={busy || draft !== null}>
          <IconPlus size={12} />
          {copy.add}
        </button>
      </header>}
      {compact ? <button type="button" data-mcp-add hidden onClick={openDraft} /> : null}

      {compact ? null : <p className="ob-hint">{copy.intro}</p>}

      {servers.length === 0 && !draft ? <p className="ob-hint">{copy.empty}</p> : null}

      <ul className="ob-mcp-list">
        {servers.map((server) => {
          const open = openId === server.id
          const label = server.name || server.id
          return <li key={server.id} className="ob-mcp" data-mcp={server.id}>
            <button type="button" className="ob-mcp-head" aria-expanded={open} onClick={() => setOpenId(open ? null : server.id)}>
              <span className="ob-mcp-name">{label}</span>
              <span className="ob-mcp-right">
                <span className="ob-pill">{server.enabled ? (zh ? '已启用' : 'Enabled') : (zh ? '未启用' : 'Off')}</span>
                <span className="ob-pill">{server.transport}</span>
              </span>
            </button>
            {open ? <div className="ob-mcp-detail">
              <p className="ob-mcp-target">
                {server.accountName ? `${server.accountName} · ` : ''}
                {server.transport === 'http' ? server.url || copy.noUrl : server.command || copy.noCommand}
                {server.auth && server.auth !== 'none' ? ` · ${server.auth}${server.hasBearerToken ? ` ${copy.connected}` : ''}` : ''}
              </p>
              <div className="ob-skill-toolbar">
                <label className="ob-check">
                  <input type="checkbox" disabled={busy} checked={server.enabled} onChange={(e) => patch(server.id, { enabled: e.target.checked })} />
                  <span>{zh ? '启用' : 'Enabled'}</span>
                </label>
                <button
                  type="button"
                  className="ob-btn ob-btn-sm"
                  aria-label={zh ? `配置 ${label}` : `Configure ${label}`}
                  onClick={() => { if (saving.current) return; setError(''); setEditingId(server.id); setDraft({ ...server, bearerToken: '' }) }}
                  disabled={busy || draft !== null}
                >
                  <IconPencil size={11} />
                  {zh ? '编辑' : 'Edit'}
                </button>
                <button
                  type="button"
                  className="ob-btn ob-btn-sm"
                  aria-label={zh ? `移除 ${label}` : `Remove ${label}`}
                  disabled={busy || editingId === server.id}
                  title={editingId === server.id ? (zh ? '请先保存或取消当前编辑，再移除此服务器。' : 'Finish or cancel the open editor before removing this server.') : undefined}
                  onClick={() => write(servers.filter((s) => s.id !== server.id))}
                >
                  <IconTrash size={12} />
                  {zh ? '移除' : 'Remove'}
                </button>
              </div>
            </div> : null}
          </li>
        })}
      </ul>

      {draft ? (
        <FormDialog fallbackFocus={`#${CSS.escape(focusScope)} [data-mcp-add]`} title={editingId ? (zh ? '修改 MCP 连接' : 'Edit MCP connection') : (zh ? '添加 MCP 连接' : 'Add MCP connection')} onClose={closeDraft} size="md"><div className="ob-mcp-draft" aria-busy={busy}>
          {error ? <p className="ob-notice ob-notice-error" role="alert">{error}</p> : null}
          <fieldset disabled={busy} style={{ display: 'contents' }}>
          <div className="ob-field">
            <label htmlFor="ob-mcp-name">{copy.name}</label>
            <input id="ob-mcp-name" className="ob-input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>

          <div className="ob-field">
            <label htmlFor="ob-mcp-account">{copy.account}</label>
            <input id="ob-mcp-account" className="ob-input" value={draft.accountName ?? ''} placeholder={copy.accountPlaceholder} onChange={(e) => setDraft({ ...draft, accountName: e.target.value })} />
          </div>

          <div className="ob-field">
            <label htmlFor="ob-mcp-transport">{copy.transport}</label>
            <select
              id="ob-mcp-transport"
              className="ob-select"
              value={draft.transport}
              onChange={(e) => setDraft({ ...draft, transport: e.target.value === 'http' ? 'http' : 'stdio' })}
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
            </select>
          </div>

          {draft.transport === 'http' ? (
            <>
              <div className="ob-field">
                <label htmlFor="ob-mcp-url">{copy.url}</label>
                <input id="ob-mcp-url" className="ob-input" value={draft.url ?? ''} placeholder="https://…/mcp" onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
              </div>
              <div className="ob-field">
                <label htmlFor="ob-mcp-auth">{copy.auth}</label>
                <select id="ob-mcp-auth" className="ob-select" value={draft.auth ?? 'none'} onChange={(e) => setDraft({ ...draft, auth: e.target.value === 'oauth' ? 'oauth' : e.target.value === 'bearer' ? 'bearer' : 'none' })}>
                  <option value="none">{copy.none}</option>
                  <option value="oauth">{copy.oauth}</option>
                  <option value="bearer">{copy.bearer}</option>
                </select>
              </div>
              {draft.auth === 'bearer' ? (
                <div className="ob-field">
                  <label htmlFor="ob-mcp-token">{copy.token}</label>
                  <input id="ob-mcp-token" type="password" className="ob-input" value={draft.bearerToken ?? ''} placeholder={draft.hasBearerToken ? copy.tokenStored : copy.tokenPlaceholder} autoComplete="off" onChange={(e) => setDraft({ ...draft, bearerToken: e.target.value })} />
                </div>
              ) : null}
              {draft.auth === 'oauth' ? <p className="ob-hint">{copy.oauthHint}</p> : null}
            </>
          ) : (
            <>
              <div className="ob-field">
                <label htmlFor="ob-mcp-command">{copy.command}</label>
                <input
                  id="ob-mcp-command"
                  className="ob-input"
                  value={draft.command ?? ''}
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                />
              </div>
              <div className="ob-field">
                <label htmlFor="ob-mcp-args">{copy.args}</label>
                <input
                  id="ob-mcp-args"
                  className="ob-input"
                  value={(draft.args ?? []).join(' ')}
                  placeholder={copy.argsPlaceholder}
                  onChange={(e) => setDraft({ ...draft, args: e.target.value.split(/\s+/).filter(Boolean) })}
                />
              </div>
            </>
          )}

          <div className="ob-field">
            <label htmlFor="ob-mcp-disabled-tools">{copy.disabledTools}</label>
            <input id="ob-mcp-disabled-tools" className="ob-input" value={(draft.disabledTools ?? []).join(', ')} placeholder="delete_issue, send_message" onChange={(e) => setDraft({ ...draft, disabledTools: e.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} />
            <p className="ob-hint">{copy.disabledHint}</p>
          </div>

          <div className="ob-mcp-draft-actions">
            <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={closeDraft}>
              {copy.cancel}
            </button>
            <button
              type="button"
              className="ob-btn ob-btn-sm ob-btn-primary"
              disabled={busy || !draft.name.trim() || (draft.transport === 'http' ? !draft.url?.trim() : !draft.command?.trim())}
              onClick={() => void saveDraft()}
            >
              {busy ? (zh ? '保存中…' : 'Saving…') : copy.save}
            </button>
          </div>
          </fieldset>
        </div></FormDialog>
      ) : null}
    </section>
  )
})
