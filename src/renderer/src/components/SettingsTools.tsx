import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { CLI_CATALOG } from '../../../shared/cliCatalog'
import { localCliAgentsMdMigration } from '../../../shared/localCliTools'
import { preferenceFor, SKILL_ORIGIN_LABELS } from '../../../shared/skills'
import type { Settings } from '../../../shared/types'
import { entitySyncPlan, groupSkills, mcpServersAfterSync } from '../lib/toolSync'
import { resolveSettingsLang } from '../lib/settingsCopy'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { loadSkills, skillsReady, store, updateBot, updateSettings, useAppState } from '../state'
import { IconPlus } from './Icons'
import { SettingsAgentsMd, type AgentsMdHandle } from './SettingsAgentsMd'
import { SettingsMcp, type McpHandle } from './SettingsMcp'
import { SettingsSkills, type SkillsHandle } from './SettingsSkills'
import './SettingsTools.css'

type ToolView = 'tools' | 'agent'
type SyncMode = 'base' | 'merge'

/** Skills, MCP servers, and AGENTS.md. The second view is a local CLI, never a Bot. */
export function SettingsTools({ settings, initialView = 'tools', initialSync = false, initialCli = '' }: { settings: Settings; initialView?: ToolView; initialSync?: boolean; initialCli?: string }): ReactNode {
  const copy = useSettingsCopy().tools
  const zh = resolveSettingsLang(settings.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'
  const { bots, skills } = useAppState()
  const [view, setView] = useState<ToolView>(initialView)
  const [cliId, setCliId] = useState(initialCli)
  const [syncOpen, setSyncOpen] = useState(initialSync)
  const [mode, setMode] = useState<SyncMode>('base')
  const [baselineId, setBaselineId] = useState('')
  const [busy, setBusy] = useState(false)
  const skillsRef = useRef<SkillsHandle>(null)
  const mcpRef = useRef<McpHandle>(null)
  const filesRef = useRef<AgentsMdHandle>(null)
  const migrated = useMemo(() => localCliAgentsMdMigration(settings.localCliAgentsMd, bots), [settings.localCliAgentsMd, bots])
  const assignments = migrated.next

  useEffect(() => { if (skillsReady()) void loadSkills() }, [])
  useEffect(() => {
    const same = JSON.stringify(assignments) === JSON.stringify(settings.localCliAgentsMd ?? {})
    if (same && migrated.clearBotIds.length === 0) return
    let cancel = false
    void (async () => {
      if (!same) await updateSettings({ localCliAgentsMd: assignments })
      if (cancel) return
      for (const id of migrated.clearBotIds) await updateBot(id, { agentsMdIds: [] })
    })()
    return () => { cancel = true }
  }, [assignments, migrated.clearBotIds, settings.localCliAgentsMd])

  const applySync = async (): Promise<void> => {
    const owners = CLI_CATALOG.map((cli) => ({ id: cli.id, name: cli.label, agentsMdIds: assignments[cli.id] ?? [] }))
    const plan = entitySyncPlan(owners, mode, baselineId)
    mcpServersAfterSync(settings.mcpServers ?? [])
    const next = { ...assignments }
    for (const step of plan) next[step.id] = [...new Set([...(next[step.id] ?? []), ...step.addAgentsMd])]
    setBusy(true)
    try {
      await updateSettings({ localCliAgentsMd: next })
      tell(zh, plan.length)
      setSyncOpen(false)
    } finally { setBusy(false) }
  }
  const assign = (id: string, fileIds: string[]): void => {
    void updateSettings({ localCliAgentsMd: { ...assignments, [id]: fileIds } })
  }

  return (
    <div className="ob-tools-page" data-tools="" data-tool-view={view}>
      <p className="ob-hint ob-tools-intro">{copy.intro}</p>
      <div className="ob-tools-switch" role="tablist" aria-label={zh ? '工具范围' : 'Tools scope'}>
        <button type="button" role="tab" aria-selected={view === 'tools'} onClick={() => setView('tools')}>{zh ? '工具' : 'Tools'}</button>
        <button type="button" role="tab" aria-selected={view === 'agent'} onClick={() => setView('agent')}>{zh ? '本地 CLI' : 'Local CLI'}</button>
      </div>
      {view === 'tools' ? <ToolsSections zh={zh} settings={settings} skillsRef={skillsRef} mcpRef={mcpRef} filesRef={filesRef} assignments={assignments} onSync={() => setSyncOpen(true)} /> : (
        <CliView zh={zh} cliId={cliId} setCliId={setCliId} skills={skills} settings={settings} assignments={assignments} onAssign={assign} mcpRef={mcpRef} filesRef={filesRef} />
      )}
      {syncOpen ? <SyncDialog zh={zh} mode={mode} setMode={setMode} baselineId={baselineId} setBaselineId={setBaselineId} busy={busy} onClose={() => setSyncOpen(false)} onApply={() => void applySync()} /> : null}
    </div>
  )
}

function tell(zh: boolean, changed: number): void {
  store.toast(changed
    ? (zh ? `已为 ${changed} 个本地 CLI 补上缺少的 AGENTS.md。已启用的 MCP 服务器保持不变。` : `Added missing AGENTS.md on ${changed} local CLIs. Enabled MCP servers were left as they are.`)
    : (zh ? '没有需要增加的分配。已启用的 MCP 服务器保持不变。' : 'Nothing was missing. Enabled MCP servers were left as they are.'))
}

function ToolsSections({ zh, settings, skillsRef, mcpRef, filesRef, assignments, onSync }: {
  zh: boolean
  settings: Settings
  skillsRef: RefObject<SkillsHandle | null>
  mcpRef: RefObject<McpHandle | null>
  filesRef: RefObject<AgentsMdHandle | null>
  assignments: Record<string, string[]>
  onSync: () => void
}): ReactNode {
  return <>
    <section className="ob-tool-block" data-tool-section="skills">
      <header className="ob-tool-block-head">
        <div>
          <h3>{zh ? '技能' : 'Skills'}</h3>
          <p className="ob-hint">{zh ? '安装到共享目录后，各本地 CLI 读取自己的目录和共享目录。' : 'Install into the shared directory. Each local CLI reads its own directory and the shared one.'}</p>
        </div>
        <div className="ob-tool-block-actions">
          <button type="button" className="ob-btn ob-btn-sm" onClick={() => skillsRef.current?.sync()}>{zh ? '同步并验证' : 'Sync and verify'}</button>
          <button type="button" className="ob-btn ob-btn-sm" onClick={() => skillsRef.current?.updateFromFolder()}>{zh ? '从文件夹更新' : 'Update from folder'}</button>
          <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" onClick={() => skillsRef.current?.install()}><IconPlus size={12} />{zh ? '安装' : 'Install'}</button>
        </div>
      </header>
      <SettingsSkills ref={skillsRef} toolbar={false} />
    </section>
    <section className="ob-tool-block" data-tool-section="mcp">
      <header className="ob-tool-block-head">
        <div>
          <h3>MCP</h3>
          <p className="ob-hint">{zh ? 'MCP 服务器对本机所有本地 CLI 共用。' : 'MCP servers are shared by every local CLI on this Mac.'}</p>
        </div>
        <div className="ob-tool-block-actions">
          <button type="button" className="ob-btn ob-btn-sm" onClick={() => mcpRef.current?.add()}><IconPlus size={12} />{zh ? '添加服务器' : 'Add server'}</button>
        </div>
      </header>
      <SettingsMcp ref={mcpRef} settings={settings} compact />
    </section>
    <section className="ob-tool-block" data-tool-section="agents-md">
      <header className="ob-tool-block-head">
        <div>
          <h3>AGENTS.md</h3>
          <p className="ob-hint">{zh ? '文件分配给本地 CLI，不分配给 Bot。' : 'Files are assigned to a local CLI, not to a Bot.'}</p>
        </div>
        <div className="ob-tool-block-actions">
          <button type="button" className="ob-btn ob-btn-sm" onClick={onSync}>{zh ? '同步分配' : 'Sync assignments'}</button>
          <button type="button" className="ob-btn ob-btn-sm" onClick={() => filesRef.current?.create()}><IconPlus size={12} />{zh ? '添加' : 'Add'}</button>
        </div>
      </header>
      <SettingsAgentsMd ref={filesRef} zh={zh} assignments={assignments} />
    </section>
  </>
}

function CliView({ zh, cliId, setCliId, skills, settings, assignments, onAssign, mcpRef, filesRef }: {
  zh: boolean
  cliId: string
  setCliId: (id: string) => void
  skills: ReturnType<typeof useAppState>['skills']
  settings: Settings
  assignments: Record<string, string[]>
  onAssign: (id: string, fileIds: string[]) => void
  mcpRef: RefObject<McpHandle | null>
  filesRef: RefObject<AgentsMdHandle | null>
}): ReactNode {
  const cli = CLI_CATALOG.find((item) => item.id === cliId)
  const visible = useMemo(() => {
    if (!cli) return []
    const chain = new Set<string>(preferenceFor(cli.id))
    return groupSkills(skills.filter((skill) => chain.has(skill.origin) || skill.origin === 'project'))
  }, [cli, skills])
  return <div data-agent-view="">
    <label className="ob-field"><span className="ob-label">{zh ? '选择本地 CLI' : 'Choose a local CLI'}</span>
      <select className="ob-select" aria-label={zh ? '选择本地 CLI' : 'Choose a local CLI'} value={cliId} onChange={(event) => setCliId(event.target.value)}>
        <option value="">{zh ? '选择本地 CLI' : 'Choose a local CLI'}</option>
        {CLI_CATALOG.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
    </label>
    <p className="ob-hint">{zh ? '本地 CLI 是 Codex、Kimi 等命令行运行时，不是 Bot。' : 'A local CLI is a runtime such as Codex or Kimi, not a Bot.'}</p>
    {cli ? <>
      <section className="ob-tool-block" data-tool-section="skills">
        <header className="ob-tool-block-head"><div><h3>{zh ? '技能' : 'Skills'}</h3><p className="ob-hint">{zh ? `${cli.label} 会读取自己的技能目录和共享目录。` : `${cli.label} reads its own skill directory and the shared directory.`}</p></div></header>
        {visible.length === 0 ? <p className="ob-hint">{zh ? '这个本地 CLI 还读不到技能。' : 'This local CLI cannot read any skills yet.'}</p> : <ul className="ob-skill-list">
          {visible.map((group) => <li key={group.name} className="ob-skill-row" data-skill={group.name}>
            <div className="ob-skill-text">
              <div className="ob-skill-title"><span className="ob-skill-name">{group.name}</span>{group.sources.map((skill) => <span key={skill.id} className="ob-pill">{SKILL_ORIGIN_LABELS[skill.origin as keyof typeof SKILL_ORIGIN_LABELS] ?? skill.origin}</span>)}</div>
              {group.description ? <details data-skill-description=""><summary>{zh ? '描述' : 'Description'}</summary><p>{group.description}</p></details> : null}
            </div>
          </li>)}
        </ul>}
      </section>
      <section className="ob-tool-block" data-tool-section="mcp">
        <header className="ob-tool-block-head"><div><h3>MCP</h3><p className="ob-hint">{zh ? '这些服务器对本机所有本地 CLI 共用。这里的开关也会作用于其他本地 CLI。' : 'These servers are shared. A switch here applies to every local CLI.'}</p></div></header>
        <SettingsMcp ref={mcpRef} settings={settings} compact />
      </section>
      <section className="ob-tool-block" data-tool-section="agents-md">
        <header className="ob-tool-block-head"><div><h3>AGENTS.md</h3><p className="ob-hint">{zh ? `分配给 ${cli.label} 的文件会进入使用该本地 CLI 的回合。` : `Files assigned to ${cli.label} are included on turns that run it.`}</p></div></header>
        <SettingsAgentsMd ref={filesRef} zh={zh} cliId={cli.id} assignments={assignments} onAssign={onAssign} />
      </section>
    </> : <p className="ob-hint">{zh ? '选择一个本地 CLI，查看它能读取的技能和 MCP，并分配 AGENTS.md。' : 'Choose a local CLI to see the skills and MCP it can read, and to assign AGENTS.md.'}</p>}
  </div>
}

function SyncDialog({ zh, mode, setMode, baselineId, setBaselineId, busy, onClose, onApply }: {
  zh: boolean
  mode: SyncMode
  setMode: (mode: SyncMode) => void
  baselineId: string
  setBaselineId: (id: string) => void
  busy: boolean
  onClose: () => void
  onApply: () => void
}): ReactNode {
  return <div className="ob-tool-sync-dialog" role="dialog" aria-modal="true" aria-label={zh ? '同步 AGENTS.md' : 'Sync AGENTS.md'} data-sync-dialog="">
    <div className="ob-tool-sync-card">
      <h4>{zh ? '同步 AGENTS.md' : 'Sync AGENTS.md'}</h4>
      <p className="ob-hint">{zh ? '把缺少的 AGENTS.md 加到其他本地 CLI。不会取消已有分配，也不会关闭已启用的 MCP 服务器。' : 'Adds missing AGENTS.md to other local CLIs. It does not unassign anything or turn off an enabled MCP server.'}</p>
      <label className="ob-check"><input type="radio" name="sync-mode" value="base" checked={mode === 'base'} onChange={() => setMode('base')} />{zh ? '基准：以一个本地 CLI 为来源' : 'Base: copy from one local CLI'}</label>
      <label className="ob-check"><input type="radio" name="sync-mode" value="merge" checked={mode === 'merge'} onChange={() => setMode('merge')} />{zh ? '合并：取所有本地 CLI 的并集' : 'Merge: union across local CLIs'}</label>
      {mode === 'base' ? <label className="ob-field"><span className="ob-label">{zh ? '基准本地 CLI' : 'Base local CLI'}</span>
        <select className="ob-select" aria-label={zh ? '基准本地 CLI' : 'Base local CLI'} value={baselineId} onChange={(event) => setBaselineId(event.target.value)}>
          <option value="">{zh ? '选择本地 CLI' : 'Choose a local CLI'}</option>
          {CLI_CATALOG.map((cli) => <option key={cli.id} value={cli.id}>{cli.label}</option>)}
        </select>
      </label> : null}
      <div className="ob-skill-toolbar">
        <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={onClose}>{zh ? '取消' : 'Cancel'}</button>
        <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" disabled={busy || (mode === 'base' && !baselineId)} onClick={onApply}>{zh ? '开始同步' : 'Sync'}</button>
      </div>
    </div>
  </div>
}
