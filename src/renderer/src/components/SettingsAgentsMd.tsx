import { forwardRef, useEffect, useImperativeHandle, useState, type ReactNode } from 'react'
import type { AgentsMdRecord } from '../../../shared/agentsMd'
import { updateBot, useAppState } from '../state'

export interface AgentsMdHandle { create(): void }

/** AGENTS.md files. The landing row shows a one-line summary; the file opens on click. */
export const SettingsAgentsMd = forwardRef<AgentsMdHandle, { zh: boolean; agentId?: string }>(function SettingsAgentsMd({ zh, agentId }, ref): ReactNode {
  const { bots } = useAppState()
  const [files, setFiles] = useState<AgentsMdRecord[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const agents = bots.filter((bot) => !bot.archived)
  const agent = agents.find((bot) => bot.id === agentId)

  const load = (): void => {
    const api = window.openbot.agentsMd
    if (!api?.list) return
    void api.list().then(setFiles).catch(() => setFiles([]))
  }
  useEffect(() => { load() }, [])

  useImperativeHandle(ref, () => ({
    create: () => {
      const api = window.openbot.agentsMd
      if (!api?.create) return
      setBusy(true); setError('')
      void api.create().then((result) => {
        if (!result.ok || !result.file) { setError(result.error || (zh ? '无法添加 AGENTS.md。' : 'Could not add AGENTS.md.')); return }
        setFiles((current) => [...current.filter((item) => item.id !== result.file!.id), result.file!])
        setOpenId(result.file.id)
        setBody(`# ${result.file.title}\n`)
      }).catch(() => setError(zh ? '无法添加 AGENTS.md。' : 'Could not add AGENTS.md.')).finally(() => setBusy(false))
    }
  }), [zh])

  const open = (file: AgentsMdRecord): void => {
    setOpenId(file.id); setError(''); setBody('')
    void window.openbot.agentsMd.read(file.id).then((result) => {
      if (!result.ok) { setError(result.error || (zh ? '无法读取文件。' : 'Could not read the file.')); return }
      setBody(result.content ?? '')
    }).catch(() => setError(zh ? '无法读取文件。' : 'Could not read the file.'))
  }

  const save = (): void => {
    if (!openId) return
    setBusy(true); setError('')
    void window.openbot.agentsMd.write(openId, body).then((result) => {
      if (!result.ok) setError(result.error || (zh ? '无法保存。' : 'Could not save.'))
      else load()
    }).catch(() => setError(zh ? '无法保存。' : 'Could not save.')).finally(() => setBusy(false))
  }

  const toggle = (id: string, on: boolean): void => {
    if (!agent) return
    const next = new Set(agent.agentsMdIds ?? [])
    if (on) next.add(id)
    else next.delete(id)
    void updateBot(agent.id, { agentsMdIds: [...next] })
  }

  return <div data-agents-md="">
    {files.length === 0 ? <p className="ob-hint">{zh ? '还没有 AGENTS.md。' : 'No AGENTS.md files yet.'}</p> : null}
    <ul className="ob-skill-list">
      {files.map((file) => {
        const holders = agents.filter((bot) => (bot.agentsMdIds ?? []).includes(file.id))
        const assigned = !!agent && holders.some((bot) => bot.id === agent.id)
        return <li key={file.id} className="ob-skill-row" data-agents-file={file.id}>
          <div className="ob-skill-text">
            <button type="button" className="ob-mcp-head" onClick={() => openId === file.id ? setOpenId(null) : open(file)}>
              <span className="ob-skill-name">{file.title || 'AGENTS.md'}</span>
              <span className="ob-hint">{agent ? (assigned ? (zh ? '已分配' : 'Assigned') : (zh ? '未分配' : 'Not assigned')) : (zh ? `${holders.length} 个 Agent 已分配` : `Assigned to ${holders.length} Agents`)}</span>
            </button>
            {file.summary ? <p className="ob-hint">{file.summary}</p> : null}
            {openId === file.id ? <div className="ob-mcp-detail">
              {agent ? <label className="ob-check"><input type="checkbox" checked={assigned} onChange={(event) => toggle(file.id, event.target.checked)} /><span>{zh ? '分配给此 Agent' : 'Assign to this Agent'}</span></label> : null}
              <textarea className="ob-input" aria-label={file.title || 'AGENTS.md'} rows={8} value={body} onChange={(event) => setBody(event.target.value)} />
              <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" disabled={busy} onClick={save}>{zh ? '保存' : 'Save'}</button>
            </div> : null}
          </div>
        </li>
      })}
    </ul>
    {error ? <p role="alert" className="ob-notice ob-notice-error">{error}</p> : null}
  </div>
})
