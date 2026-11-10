import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { Bot, Settings } from '../../../shared/types'
import { entitySyncPlan, groupSkills, mcpServersAfterSync } from '../lib/toolSync'
import { resolveSettingsLang } from '../lib/settingsCopy'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { installSkill, loadSkills, skillsReady, store, syncExistingSkills, updateBot, useAppState } from '../state'
import { IconPlus } from './Icons'
import { SettingsAgentsMd, type AgentsMdHandle } from './SettingsAgentsMd'
import { SettingsMcp, type McpHandle } from './SettingsMcp'
import { SettingsSkills, type SkillsHandle } from './SettingsSkills'
import './SettingsTools.css'

type ToolView = 'tools' | 'agent'
type SyncMode = 'base' | 'merge'

/** Skills, MCP servers, and AGENTS.md for every Agent. Built-in tools stay hidden. */
export function SettingsTools({ settings, initialView = 'tools', initialSync = false }: { settings: Settings; initialView?: ToolView; initialSync?: boolean }): ReactNode {
  const copy = useSettingsCopy().tools
  const zh = resolveSettingsLang(settings.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'
  const { bots, skills } = useAppState()
  const [view, setView] = useState<ToolView>(initialView)
  const [agentId, setAgentId] = useState('')
  const [syncOpen, setSyncOpen] = useState(initialSync)
  const [mode, setMode] = useState<SyncMode>('base')
  const [baselineId, setBaselineId] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<'install' | 'sync' | 'update' | 'mcp' | 'file' | null>(null)
  const skillsRef = useRef<SkillsHandle>(null)
  const mcpRef = useRef<McpHandle>(null)
  const filesRef = useRef<AgentsMdHandle>(null)
  const skillsSection = useRef<HTMLDetailsElement>(null)
  const mcpSection = useRef<HTMLDetailsElement>(null)
  const filesSection = useRef<HTMLDetailsElement>(null)
  const show = (section: { current: HTMLDetailsElement | null }, run: () => void, next: 'install' | 'sync' | 'update' | 'mcp' | 'file'): void => {
    if (section.current) { section.current.open = true; run(); return }
    setView('tools'); setPending(next)
  }
  const pendingOnce = useRef<string | null>(null)
  useEffect(() => {
    if (!pending) { pendingOnce.current = null; return }
    if (pendingOnce.current === pending) return
    pendingOnce.current = pending
    const section = pending === 'mcp' ? mcpSection : pending === 'file' ? filesSection : skillsSection
    if (section.current) section.current.open = true
    if (pending === 'install') { if (skillsRef.current) skillsRef.current.install(); else void installSkill() }
    else if (pending === 'sync') { if (skillsRef.current) skillsRef.current.sync(); else void syncExistingSkills() }
    else if (pending === 'update') { if (skillsRef.current) skillsRef.current.updateFromFolder(); else void installSkill(true) }
    else if (pending === 'mcp') mcpRef.current?.add()
    else filesRef.current?.create()
    setPending(null)
  }, [pending])
  const agents = bots.filter((bot) => !bot.archived)
  const agent = agents.find((bot) => bot.id === agentId)

  useEffect(() => { if (skillsReady()) void loadSkills() }, [])

  const applySync = async (): Promise<void> => {
    const plan = entitySyncPlan(agents.map((bot) => ({ botId: bot.id, name: bot.name, skillIds: bot.skills ?? [], agentsMdIds: bot.agentsMdIds ?? [] })), mode, baselineId)
    mcpServersAfterSync(settings.mcpServers ?? [])
    setBusy(true)
    try {
      let changed = 0
      for (const step of plan) {
        const target = agents.find((bot) => bot.id === step.botId)
        if (!target) continue
        const saved = await updateBot(target.id, {
          skills: [...new Set([...(target.skills ?? []), ...step.addSkills])],
          agentsMdIds: [...new Set([...(target.agentsMdIds ?? []), ...step.addAgentsMd])]
        })
        if (saved) changed++
      }
      store.toast(changed
        ? (zh ? `已为 ${changed} 个 Agent 补上缺少的技能和 AGENTS.md。已启用的 MCP 服务器保持不变。` : `Added missing skills and AGENTS.md on ${changed} Agents. Enabled MCP servers were left as they are.`)
        : (zh ? '没有需要增加的分配。已启用的 MCP 服务器保持不变。' : 'Nothing was missing. Enabled MCP servers were left as they are.'))
      setSyncOpen(false)
    } finally { setBusy(false) }
  }

  return (
    <div className="ob-set-stack" data-tools="" data-tool-view={view}>
      <p className="ob-hint ob-tools-intro">{copy.intro}</p>
      <div className="ob-tools-toolbar">
        <div className="ob-tools-tabs" role="tablist" aria-label={zh ? '工具视图' : 'Tools view'}>
          <button type="button" role="tab" aria-selected={view === 'tools'} className="ob-btn ob-btn-sm" onClick={() => setView('tools')}>{zh ? '工具视图' : 'Tools'}</button>
          <button type="button" role="tab" aria-selected={view === 'agent'} className="ob-btn ob-btn-sm" onClick={() => setView('agent')}>{zh ? 'Agent 视图' : 'Agent'}</button>
        </div>
        {view === 'tools' ? <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" onClick={() => setSyncOpen(true)}>{zh ? '一键同步' : 'Sync all'}</button> : null}
        <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" onClick={() => show(skillsSection, () => { if (skillsRef.current) skillsRef.current.install(); else void installSkill() }, 'install')}><IconPlus size={12} />{copy.skillsInstall}</button>
        <button type="button" className="ob-btn ob-btn-sm" onClick={() => show(skillsSection, () => { if (skillsRef.current) skillsRef.current.sync(); else void syncExistingSkills() }, 'sync')}>{zh ? '同步并验证' : 'Sync and verify'}</button>
        <button type="button" className="ob-btn ob-btn-sm" onClick={() => show(skillsSection, () => { if (skillsRef.current) skillsRef.current.updateFromFolder(); else void installSkill(true) }, 'update')}>{zh ? '从文件夹更新' : 'Update from folder'}</button>
        <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" onClick={() => show(mcpSection, () => mcpRef.current?.add(), 'mcp')}><IconPlus size={12} />{zh ? '添加服务器' : 'Add server'}</button>
        <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" onClick={() => show(filesSection, () => filesRef.current?.create(), 'file')}><IconPlus size={12} />{zh ? '添加 AGENTS.md' : 'Add AGENTS.md'}</button>
      </div>
      {view === 'tools' ? <ToolsSections zh={zh} agents={agents} skillsRef={skillsRef} mcpRef={mcpRef} filesRef={filesRef} skillsSection={skillsSection} mcpSection={mcpSection} filesSection={filesSection} settings={settings} /> : (
        <div data-agent-view="">
          <label className="ob-field"><span className="ob-label">{zh ? '选择 Agent' : 'Choose an Agent'}</span>
            <select className="ob-select" aria-label={zh ? '选择 Agent' : 'Choose an Agent'} value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              <option value="">{zh ? '选择 Agent' : 'Choose an Agent'}</option>
              {agents.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select>
          </label>
          {agent ? <AgentSections zh={zh} agent={agent} skills={skills} settings={settings} mcpRef={mcpRef} filesRef={filesRef} skillsSection={skillsSection} mcpSection={mcpSection} filesSection={filesSection} /> : <p className="ob-hint">{zh ? '选择一个 Agent，管理它的技能、MCP 和 AGENTS.md。' : 'Choose an Agent to manage its skills, MCP, and AGENTS.md.'}</p>}
        </div>
      )}
      {syncOpen ? <SyncDialog zh={zh} mode={mode} setMode={setMode} agents={agents} baselineId={baselineId} setBaselineId={setBaselineId} busy={busy} onClose={() => setSyncOpen(false)} onApply={() => void applySync()} /> : null}
    </div>
  )
}

function ToolsSections({ zh, agents, skillsRef, mcpRef, filesRef, skillsSection, mcpSection, filesSection, settings }: {
  zh: boolean
  agents: Bot[]
  skillsRef: RefObject<SkillsHandle | null>
  mcpRef: RefObject<McpHandle | null>
  filesRef: RefObject<AgentsMdHandle | null>
  skillsSection: RefObject<HTMLDetailsElement | null>
  mcpSection: RefObject<HTMLDetailsElement | null>
  filesSection: RefObject<HTMLDetailsElement | null>
  settings: Settings
}): ReactNode {
  return <>
    <details ref={skillsSection} className="ob-tool-section" data-tool-section="skills">
      <summary>{zh ? '技能' : 'Skills'}</summary>
      <SettingsSkills ref={skillsRef} toolbar={false} />
      <SkillCoverage zh={zh} agents={agents} />
    </details>
    <details ref={mcpSection} className="ob-tool-section" data-tool-section="mcp">
      <summary>MCP</summary>
      <p className="ob-hint">{zh ? 'MCP 服务器对本机所有 Agent 共用。' : 'MCP servers are shared by every Agent on this Mac.'}</p>
      <SettingsMcp ref={mcpRef} settings={settings} compact />
    </details>
    <details ref={filesSection} className="ob-tool-section" data-tool-section="agents-md">
      <summary>AGENTS.md</summary>
      <SettingsAgentsMd ref={filesRef} zh={zh} />
    </details>
  </>
}

function SkillCoverage({ zh, agents }: { zh: boolean; agents: Bot[] }): ReactNode {
  const { skills } = useAppState()
  if (!skills.length || agents.length === 0) return null
  return <ul className="ob-skill-list">
    {groupSkills(skills).map((group) => {
      const ids = new Set(group.sources.map((skill) => skill.id))
      const have = agents.filter((bot) => (bot.skills ?? []).some((id) => ids.has(id)))
      return <li key={group.name} className="ob-hint">{group.name} · {zh ? `${have.length}/${agents.length} 个 Agent 已分配` : `${have.length}/${agents.length} Agents assigned`}</li>
    })}
  </ul>
}

function AgentSections({ zh, agent, skills, settings, mcpRef, filesRef, skillsSection, mcpSection, filesSection }: {
  zh: boolean
  agent: Bot
  skills: ReturnType<typeof useAppState>['skills']
  settings: Settings
  mcpRef: RefObject<McpHandle | null>
  filesRef: RefObject<AgentsMdHandle | null>
  skillsSection: RefObject<HTMLDetailsElement | null>
  mcpSection: RefObject<HTMLDetailsElement | null>
  filesSection: RefObject<HTMLDetailsElement | null>
}): ReactNode {
  const groups = groupSkills(skills)
  const toggleSkill = (ids: string[], on: boolean): void => {
    const next = new Set(agent.skills ?? [])
    ids.forEach((id) => { if (on) next.add(id); else next.delete(id) })
    void updateBot(agent.id, { skills: [...next] })
  }
  return <>
    <details ref={skillsSection} className="ob-tool-section" data-tool-section="skills">
      <summary>{zh ? '技能' : 'Skills'}</summary>
      {groups.length === 0 ? <p className="ob-hint">{zh ? '还没有安装技能。' : 'No skills installed yet.'}</p> : <ul className="ob-skill-list">
        {groups.map((group) => {
          const ids = group.sources.map((skill) => skill.id)
          const on = ids.some((id) => (agent.skills ?? []).includes(id))
          return <li key={group.name} className="ob-skill-row" data-skill={group.name}>
            <label className="ob-check"><input type="checkbox" checked={on} onChange={(event) => toggleSkill(ids, event.target.checked)} /><span className="ob-skill-name">{group.name}</span></label>
            <span className="ob-skill-title">{group.sources.map((skill) => <span key={skill.id} className="ob-pill">{skill.origin}</span>)}</span>
            {group.description ? <details data-skill-description=""><summary>{zh ? '描述' : 'Description'}</summary><p>{group.description}</p></details> : null}
          </li>
        })}
      </ul>}
    </details>
    <details ref={mcpSection} className="ob-tool-section" data-tool-section="mcp">
      <summary>MCP</summary>
      <p className="ob-hint">{zh ? 'MCP 服务器对本机所有 Agent 共用。这里的启用状态会作用于每个 Agent。' : 'MCP servers are shared. Enabling one here applies to every Agent.'}</p>
      <SettingsMcp ref={mcpRef} settings={settings} compact />
    </details>
    <details ref={filesSection} className="ob-tool-section" data-tool-section="agents-md">
      <summary>AGENTS.md</summary>
      <SettingsAgentsMd ref={filesRef} zh={zh} agentId={agent.id} />
    </details>
  </>
}

function SyncDialog({ zh, mode, setMode, agents, baselineId, setBaselineId, busy, onClose, onApply }: {
  zh: boolean
  mode: SyncMode
  setMode: (mode: SyncMode) => void
  agents: Bot[]
  baselineId: string
  setBaselineId: (id: string) => void
  busy: boolean
  onClose: () => void
  onApply: () => void
}): ReactNode {
  return <div className="ob-tool-sync-dialog" role="dialog" aria-modal="true" aria-label={zh ? '一键同步' : 'Sync all'} data-sync-dialog="">
    <div className="ob-tool-sync-card">
      <h4>{zh ? '一键同步' : 'Sync all'}</h4>
      <p className="ob-hint">{zh ? '把缺少的技能和 AGENTS.md 加到其他 Agent。不会取消已有分配，也不会关闭已启用的 MCP 服务器。' : 'Adds missing skills and AGENTS.md. It does not unassign anything or turn off an enabled MCP server.'}</p>
      <label className="ob-check"><input type="radio" name="sync-mode" value="base" checked={mode === 'base'} onChange={() => setMode('base')} />{zh ? '基准：以一个 Agent 为来源' : 'Base: copy from one Agent'}</label>
      <label className="ob-check"><input type="radio" name="sync-mode" value="merge" checked={mode === 'merge'} onChange={() => setMode('merge')} />{zh ? '合并：取所有 Agent 的并集' : 'Merge: union across Agents'}</label>
      {mode === 'base' ? <label className="ob-field"><span className="ob-label">{zh ? '基准 Agent' : 'Base Agent'}</span>
        <select className="ob-select" aria-label={zh ? '基准 Agent' : 'Base Agent'} value={baselineId} onChange={(event) => setBaselineId(event.target.value)}>
          <option value="">{zh ? '选择 Agent' : 'Choose an Agent'}</option>
          {agents.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
        </select>
      </label> : null}
      <div className="ob-skill-toolbar">
        <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={onClose}>{zh ? '取消' : 'Cancel'}</button>
        <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" disabled={busy || (mode === 'base' && !baselineId)} onClick={onApply}>{zh ? '开始同步' : 'Sync'}</button>
      </div>
    </div>
  </div>
}
