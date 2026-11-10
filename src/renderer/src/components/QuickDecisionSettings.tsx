import type { ReactNode } from 'react'
import type { Settings } from '../../../shared/types'
import { runtimeModels } from '../../../shared/botRuntime'
import { updateSettings, useAppState } from '../state'

export function QuickDecisionSettings({ settings, zh }: { settings: Settings; zh: boolean }): ReactNode {
  const { backends } = useAppState()
  const eligible = backends.filter(item => item.status === 'available' && (item.kind === 'cloud-api' || item.kind === 'local-server' || item.id === 'pi'))
  const selected = settings.quickDecision
  const backend = backends.find(item => item.id === selected?.backendId)
  const choices = selected ? runtimeModels(selected.backendId, backend?.models ?? [], selected.modelId) : []
  return <section className="ob-set-card">
    <h3>{zh ? '快速派发判断（可选）' : 'Optional routing model'}</h3>
    <p className="ob-hint">{zh ? '只提供是否派发的建议。Bot 与执行模型保持各自选择；不可用时继续由 Bot 处理。' : 'Offers routing advice only. Bot and execution models keep their own selections; the Bot handles unavailable advice.'}</p>
    <label className="ob-set-row">
      <span className="ob-set-row-title">{zh ? '判断模型连接' : 'Routing connection'}</span>
      <select className="ob-select ob-settings-select" aria-label={zh ? '判断模型连接' : 'Routing connection'} value={selected?.backendId ?? ''}
        onChange={event => {
          const id = event.target.value, next = eligible.find(item => item.id === id)
          void updateSettings({ quickDecision: next ? { backendId: id, modelId: settings.backends[id]?.defaultModelId || next.models[0]?.id || 'default' } : null })
        }}>
        <option value="">{zh ? '关闭' : 'Off'}</option>
        {selected && !eligible.some(item => item.id === selected.backendId) ? <option value={selected.backendId}>{backend?.label ?? selected.backendId} · {zh ? '当前不可用' : 'Unavailable'}</option> : null}
        {eligible.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
    </label>
    {selected ? <label className="ob-set-row">
      <span className="ob-set-row-title">{zh ? '模型' : 'Model'}</span>
      <select className="ob-select ob-settings-select" aria-label={zh ? '派发判断模型' : 'Routing model'} value={selected.modelId}
        onChange={event => void updateSettings({ quickDecision: { ...selected, modelId: event.target.value } })}>
        {choices.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
      </select>
    </label> : null}
  </section>
}
