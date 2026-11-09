import { useState, type ReactNode } from 'react'
import { useAppState, store } from '../state'
import { TOOL_GROUPS, groupOfTool, toolConsistency, toolSyncPlan, type AgentToolCell } from '../lib/toolSync'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { resolveSettingsLang } from '../lib/settingsCopy'

/** Per-tool Agent consistency matrix with baseline sync (add-only). */
export function SettingsToolSync(): ReactNode {
  const { bots, settings } = useAppState()
  const copy = useSettingsCopy().tools
  const zh = resolveSettingsLang(settings?.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'
  const [syncFor, setSyncFor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const allTools = TOOL_GROUPS.flatMap((group) => group.ids)
  const usableBots = bots.filter((bot) => !bot.archived)

  const cellsFor = (toolId: string): AgentToolCell[] =>
    usableBots.map((bot) => ({ botId: bot.id, name: bot.name, state: bot.tools.includes(toolId) ? 'on' : 'off' }))

  const applySync = async (toolId: string, baselineId: string): Promise<void> => {
    const baseline = usableBots.find((bot) => bot.id === baselineId)
    if (!baseline) return
    setBusy(true)
    try {
      const plan = toolSyncPlan(cellsFor(toolId), baselineId, toolId, baseline.tools)
      let applied = 0
      for (const step of plan) {
        const target = usableBots.find((bot) => bot.id === step.botId)
        if (!target) continue
        const result = await window.openbot.bots.update(target.id, { tools: [...target.tools, ...step.add] })
        if (result.ok) applied++
      }
      store.toast(zh ? `已按「${baseline.name}」为 ${applied} 个 Agent 启用该工具；未启用的不会被移除。` : `Enabled the tool on ${applied} Agents per “${baseline.name}”; nothing was removed.`)
    } finally {
      setBusy(false)
      setSyncFor(null)
    }
  }

  return <div className="ob-set-stack" data-tool-sync="">
    <p className="ob-hint">{zh ? '视角：每种工具在哪些 Agent 上启用。同步只增不减——以某个 Agent 为基准，把该工具装到缺少的 Agent 上，不会替你关闭任何已授权工具。' : 'Per tool, see which Agents have it enabled. Syncing is add-only: pick a baseline Agent and the tool is added where missing; nothing is ever revoked.'}</p>
    {TOOL_GROUPS.map((group) => {
      const rows = allTools.filter((id) => groupOfTool(id)?.id === group.id)
      if (!rows.length || usableBots.length === 0) return null
      return <section key={group.id} className="ob-tool-group" aria-label={zh ? group.zh : group.en}>
        <h3 className="ob-tool-group-title">{zh ? group.zh : group.en}</h3>
        <ul className="ob-tool-rows">{rows.map((toolId) => {
          const cells = cellsFor(toolId)
          const consistency = toolConsistency(cells)
          return <li key={toolId} className="ob-tool-row" data-tool={toolId}>
            <div className="ob-tool-row-head">
              <code className="ob-tool-name">{toolId}</code>
              <span className={`ob-tool-badge${consistency.consistent ? ' is-consistent' : ''}`}>{consistency.consistent
                ? (zh ? '一致' : 'Consistent')
                : (zh ? `${consistency.off} 个未启用` : `${consistency.off} off`)}</span>
              <button type="button" className="ob-btn ob-btn-sm" disabled={busy || consistency.consistent} onClick={() => setSyncFor(toolId)}>{copy.sync}</button>
            </div>
            <div className="ob-tool-agents">{cells.map((cell) => (
              <span key={cell.botId} className={`ob-tool-chip${cell.state === 'on' ? ' is-on' : ''}`} title={`${cell.name}: ${cell.state === 'on' ? (zh ? '已启用' : 'enabled') : (zh ? '未启用' : 'disabled')}`}>
                {cell.name}
              </span>
            ))}</div>
          </li>
        })}</ul>
      </section>
    })}
    {syncFor ? <div className="ob-tool-sync-dialog" role="dialog" aria-modal="true" aria-label={zh ? '选择基准 Agent' : 'Choose the baseline Agent'}>
      <div className="ob-tool-sync-card">
        <h4>{zh ? `以哪个 Agent 为基准同步「${syncFor}」？` : `Sync “${syncFor}” from which Agent?`}</h4>
        <p className="ob-hint">{zh ? '会把基准 Agent 已启用的该工具装到其他缺少的 Agent 上；其他工具不受影响，已启用的不会被关闭。' : 'Adds this tool where the baseline has it enabled and others lack it. Other tools are untouched; nothing is removed.'}</p>
        <ul className="ob-tool-sync-baselines">{usableBots.map((bot) => (
          <li key={bot.id}><button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => void applySync(syncFor, bot.id)}>
            {bot.name}{bot.tools.includes(syncFor) ? '' : (zh ? '（未启用该工具）' : ' (does not have it)')}
          </button></li>
        ))}</ul>
        <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => setSyncFor(null)}>{zh ? '取消' : 'Cancel'}</button>
      </div>
    </div> : null}
  </div>
}
