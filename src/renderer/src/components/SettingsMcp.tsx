import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { McpServerConfig, Settings } from '../../../shared/types'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { store, updateSettings } from '../state'
import { IconPencil, IconPlus, IconTrash } from './Icons'
import './SettingsMcp.css'

interface SettingsMcpProps {
  settings: Settings
  /** Apps owns the primary connect path. Custom servers stay, preset cards do not. */
  hideCatalog?: boolean
}

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

/*
 * The catalogue prefills only what OpenBOT can state truthfully.
 *
 * A card used to read as a one-click connector and deliver a blank form with a
 * dead button: it set the name, `transport: 'http'` and `auth: 'oauth'` and left
 * `url` empty, which is the one field the submit button waits on. No provider's
 * remote MCP endpoint is carried anywhere in this build, and a guessed URL is
 * worse than none — it would be saved, handed to the agent CLI and fail at
 * connect time with an error that reads as the user's mistake.
 *
 * So a card now says on its face that the endpoint is the part still to supply,
 * and opens the form with the cursor already in that field.
 */
const CONNECTORS = [
  { id: 'github', name: 'GitHub', hint: 'Repositories, issues and pull requests' },
  { id: 'slack', name: 'Slack', hint: 'Channels, messages and search' },
  { id: 'google-drive', name: 'Google Drive', hint: 'Files and documents' },
  { id: 'notion', name: 'Notion', hint: 'Pages and databases' },
  { id: 'linear', name: 'Linear', hint: 'Issues and projects' }
] as const

/** MCP server list: enable, edit connection details, remove. */
export function SettingsMcp({ settings, hideCatalog = false }: SettingsMcpProps): ReactNode {
  const copy = useSettingsCopy().mcp
  const [draft, setDraft] = useState<McpServerConfig | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  /* Set when a catalogue card opens the form, so the field it is waiting on
     takes the cursor instead of the user having to hunt for it. */
  const [focusUrl, setFocusUrl] = useState(false)
  const urlRef = useRef<HTMLInputElement>(null)
  const servers = settings.mcpServers ?? []

  const write = (next: McpServerConfig[]): void => {
    void updateSettings({ mcpServers: next })
  }

  const patch = (id: string, change: Partial<McpServerConfig>): void =>
    write(servers.map((s) => (s.id === id ? { ...s, ...change } : s)))

  const closeDraft = (): void => {
    setDraft(null)
    setEditingId(null)
    setFocusUrl(false)
  }

  useEffect(() => {
    if (!focusUrl) return
    urlRef.current?.focus()
    setFocusUrl(false)
  }, [focusUrl])

  /*
   * Settings are broadcast to every window, so the server this form is editing
   * can disappear from under it — the disabled Remove button below only covers
   * this window. Either way the loss used to be silent: the form stayed open
   * holding the typed data and "Save account" mapped over a list that no longer
   * held the id, writing nothing and saying nothing. Close it and say why.
   */
  useEffect(() => {
    if (editingId === null) return
    if (servers.some((server) => server.id === editingId)) return
    closeDraft()
    store.toast(copy.removed, 'error')
  }, [editingId, servers])

  return (
    <section className="ob-settings-section">
      <header className="ob-settings-head">
        <h3 className="ob-label">{copy.title}</h3>
        <button type="button" className="ob-btn ob-btn-sm" onClick={() => { setEditingId(null); setDraft(blank()) }} disabled={draft !== null}>
          <IconPlus size={12} />
          {copy.add}
        </button>
      </header>

      <p className="ob-hint">{copy.intro}</p>

      {hideCatalog ? null : <div className="ob-connector-catalog" aria-label="Connector catalogue">
        {CONNECTORS.map((connector) => (
          <button
            key={connector.id}
            type="button"
            className="ob-connector-card"
            disabled={draft !== null}
            onClick={() => {
              setEditingId(null)
              setDraft({ ...blank(), id: `mcp-${connector.id}-${Date.now()}`, name: connector.name, provider: connector.id, transport: 'http', auth: 'oauth' })
              setFocusUrl(true)
            }}
          >
            <strong>{connector.name}</strong>
            <span>{connector.hint}</span>
            <em>{copy.addEndpoint}</em>
          </button>
        ))}
      </div>}

      {hideCatalog ? null : <p className="ob-hint">{copy.catalogHint}</p>}

      {servers.length === 0 && !draft ? <p className="ob-hint">{copy.empty}</p> : null}

      <ul className="ob-mcp-list">
        {servers.map((server) => (
          <li key={server.id} className="ob-mcp">
            <div className="ob-mcp-head">
              <label className="ob-check">
                <input type="checkbox" checked={server.enabled} onChange={(e) => patch(server.id, { enabled: e.target.checked })} />
                <span className="ob-mcp-name">{server.name || server.id}</span>
              </label>
              <span className="ob-mcp-right">
                <span className="ob-pill">{server.transport}</span>
                <button
                  type="button"
                  className="ob-icon-btn"
                  aria-label={`Configure ${server.name || server.id}`}
                  onClick={() => { setEditingId(server.id); setDraft({ ...server, bearerToken: '' }) }}
                  disabled={draft !== null}
                >
                  <IconPencil size={11} />
                </button>
                {/* Removing the server whose editor is open discarded the edit
                    in silence — the form stayed open over a row that no longer
                    existed, and its save mapped over nothing. Removal waits
                    until that editor is closed. */}
                <button
                  type="button"
                  className="ob-icon-btn"
                  aria-label={`Remove ${server.name || server.id}`}
                  disabled={editingId === server.id}
                  title={editingId === server.id ? 'Finish or cancel the open editor before removing this server.' : undefined}
                  onClick={() => write(servers.filter((s) => s.id !== server.id))}
                >
                  <IconTrash size={12} />
                </button>
              </span>
            </div>
            <p className="ob-mcp-target">
              {server.accountName ? `${server.accountName} · ` : ''}
              {server.transport === 'http' ? server.url || copy.noUrl : server.command || copy.noCommand}
              {server.auth && server.auth !== 'none' ? ` · ${server.auth}${server.hasBearerToken ? ` ${copy.connected}` : ''}` : ''}
            </p>
          </li>
        ))}
      </ul>

      {draft ? (
        <div className="ob-mcp-draft">
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
                <input ref={urlRef} id="ob-mcp-url" className="ob-input" value={draft.url ?? ''} placeholder="https://…/mcp" onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
                {/* The catalogue card cannot fill this in, so it names what it
                    is waiting for rather than leaving a dead submit button
                    with no explanation. */}
                {draft.provider && !draft.url?.trim() ? (
                  <p className="ob-hint ob-mcp-await">
                    Paste the remote MCP endpoint published by {draft.name || 'this provider'}. It is the only field left
                    before this account can be added.
                  </p>
                ) : null}
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
            <button type="button" className="ob-btn ob-btn-sm" onClick={closeDraft}>
              {copy.cancel}
            </button>
            <button
              type="button"
              className="ob-btn ob-btn-sm ob-btn-primary"
              disabled={!draft.name.trim() || (draft.transport === 'http' ? !draft.url?.trim() : !draft.command?.trim())}
              onClick={() => {
                write(editingId ? servers.map((server) => server.id === editingId ? draft : server) : [...servers, draft])
                closeDraft()
              }}
            >
              {copy.save}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
