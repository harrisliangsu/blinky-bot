import type { ReactNode } from 'react'
import { listedBackends } from '../../../shared/backendSections'
import type { BackendInfo } from '../../../shared/types'
import { runtimeModels, runtimeSource } from '../../../shared/botRuntime'
import { modelAcceptsThinking, thinkingOptions, thinkingWire, type ThinkingDepth } from '../../../shared/thinking'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import './BotRuntimeFields.css'

export interface RuntimeChoice {
  backendId: string
  modelId: string
  thinking?: ThinkingDepth
}

interface BotRuntimeFieldsProps {
  backends: BackendInfo[]
  configs: Record<string, { added?: boolean; hasApiKey?: boolean; apiKey?: string; defaultModelId?: string } | undefined> | undefined
  backendId: string
  modelId: string
  thinking?: ThinkingDepth
  onChange: (next: RuntimeChoice) => void
}

const DEPTH_LABEL = {
  off: 'thinkingOff',
  low: 'thinkingLow',
  medium: 'thinkingMedium',
  high: 'thinkingHigh',
  xhigh: 'thinkingXHigh',
  max: 'thinkingMax',
  ultra: 'thinkingUltra'
} as const

/**
 * Source, CLI or provider, model, and thinking depth for one Bot.
 * Only installed, usable CLIs and providers the user added are listed.
 */
export function BotRuntimeFields({
  backends,
  configs,
  backendId,
  modelId,
  thinking,
  onChange
}: BotRuntimeFieldsProps): ReactNode {
  const copyAll = useSettingsCopy()
  const copy = copyAll.bots
  const listed = listedBackends(backends, configs, backendId)
  const current = backends.find((item) => item.id === backendId)
  const derived = runtimeSource(backendId, current?.kind)
  const models = runtimeModels(backendId, current?.models ?? [], modelId)
  const wire = thinkingWire(backendId)
  const accepts = wire !== null && modelAcceptsThinking(backendId, modelId)
  // Here "default" delegates to the CLI itself, independently of the model
  // preference stored on the connection (which only seeds new Bots).
  const depths = thinkingOptions(backendId, modelId, current?.models ?? [])
  const depthLabels = copy

  return (
    <div className="ob-bot-runtime-grid">
      <label className="ob-bot-runtime-connection">
        <span className="ob-sr-only">{derived === 'cli' ? copy.runtimeCli : copy.runtimeProvider}</span>
        <select
          className="ob-select ob-settings-select"
          aria-label={derived === 'cli' ? copy.runtimeCli : copy.runtimeProvider}
          title={current?.label ?? backendId}
          value={listed.some((item) => item.id === backendId) ? backendId : ''}
          onChange={(e) => onChange({ backendId: e.target.value, modelId: 'default' })}
        >
          {listed.length === 0 ? <option value="">{copy.runtimeEmpty}</option> : null}
          {(['cli', 'provider'] as const).map((source) => {
            const pool = listed.filter((item) => runtimeSource(item.id, item.kind) === source)
            return pool.length ? <optgroup key={source} label={source === 'cli' ? copy.sourceCli : copy.sourceProvider}>
              {pool.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </optgroup> : null
          })}
        </select>
      </label>
      <label className="ob-bot-runtime-model">
        <span className="ob-sr-only">{copy.runtimeModel}</span>
        <select
          className="ob-select ob-settings-select"
          aria-label={copy.runtimeModel}
          title={models.find((model) => model.id === modelId)?.label ?? modelId}
          value={models.some((model) => model.id === modelId) ? modelId : 'default'}
          onChange={(e) => {
            const next = e.target.value
            const supported = thinkingOptions(backendId, next, current?.models ?? [])
            onChange({ backendId, modelId: next, ...(thinking && supported.includes(thinking) ? { thinking } : {}) })
          }}
        >
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.id === 'default' ? copy.runtimeModelDefault : model.label}
            </option>
          ))}
        </select>
      </label>
      {wire ? (
        <label className="ob-bot-runtime-depth">
          <span className="ob-sr-only">{copy.thinking}</span>
          <select
            className="ob-select ob-settings-select"
            aria-label={copy.thinking}
            value={thinking ?? ''}
            disabled={!accepts || (depths.length === 0 && !thinking)}
            title={accepts && depths.length > 0 ? (thinking ? depthLabels[DEPTH_LABEL[thinking]] : copy.thinkingDefault) : copy.thinkingUnavailable}
            onChange={(e) => {
              const next = e.target.value
              onChange({
                backendId,
                modelId,
                ...(next ? { thinking: next as ThinkingDepth } : {})
              })
            }}
          >
            <option value="">{copy.thinkingDefault}</option>
            {thinking && !depths.includes(thinking) ? <option value={thinking} disabled>{depthLabels[DEPTH_LABEL[thinking]]}</option> : null}
            {depths.map((depth) => (
              <option key={depth} value={depth}>
                {depthLabels[DEPTH_LABEL[depth]]}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  )
}
