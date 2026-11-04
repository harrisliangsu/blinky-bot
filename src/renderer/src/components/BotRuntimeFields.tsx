import { useEffect, useState, type ReactNode } from 'react'
import { listedBackends } from '../../../shared/backendSections'
import type { BackendInfo } from '../../../shared/types'
import { runtimeModels, runtimeSource, type RuntimeSource } from '../../../shared/botRuntime'
import { THINKING_DEPTHS, modelAcceptsThinking, thinkingWire, type ThinkingDepth } from '../../../shared/thinking'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import './BotRuntimeFields.css'

export interface RuntimeChoice {
  backendId: string
  modelId: string
  thinking?: ThinkingDepth
}

interface BotRuntimeFieldsProps {
  backends: BackendInfo[]
  configs: Record<string, { added?: boolean; hasApiKey?: boolean; apiKey?: string } | undefined> | undefined
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
  xhigh: 'thinkingXHigh'
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
  const copy = useSettingsCopy().bots
  const listed = listedBackends(backends, configs, backendId)
  const current = backends.find((item) => item.id === backendId)
  const derived = runtimeSource(backendId, current?.kind)
  const [source, setSource] = useState<RuntimeSource>(derived)

  useEffect(() => {
    setSource(derived)
  }, [derived])

  const pool = listed.filter((item) => runtimeSource(item.id, item.kind) === source)
  const models = runtimeModels(backendId, current?.models ?? [], modelId)
  const wire = thinkingWire(backendId)
  const accepts = wire !== null && modelAcceptsThinking(backendId, modelId)
  const depthLabels = copy

  const pickSource = (next: RuntimeSource): void => {
    setSource(next)
    const first = listed.find((item) => runtimeSource(item.id, item.kind) === next)
    if (!first || first.id === backendId) return
    onChange({
      backendId: first.id,
      modelId: 'default',
      ...(thinking && thinkingWire(first.id) ? { thinking } : {})
    })
  }

  return (
    <div className="ob-bot-runtime-grid">
      <label>
        {copy.source}
        <select
          className="ob-select ob-settings-select"
          aria-label={copy.source}
          value={source}
          onChange={(e) => pickSource(e.target.value as RuntimeSource)}
        >
          <option value="cli">{copy.sourceCli}</option>
          <option value="provider">{copy.sourceProvider}</option>
        </select>
      </label>
      <label>
        {source === 'cli' ? copy.runtimeCli : copy.runtimeProvider}
        <select
          className="ob-select ob-settings-select"
          aria-label={source === 'cli' ? copy.runtimeCli : copy.runtimeProvider}
          value={pool.some((item) => item.id === backendId) ? backendId : ''}
          onChange={(e) =>
            onChange({
              backendId: e.target.value,
              modelId: 'default',
              ...(thinking && thinkingWire(e.target.value) ? { thinking } : {})
            })
          }
        >
          {pool.length === 0 ? <option value="">{copy.runtimeEmpty}</option> : null}
          {pool.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        {copy.runtimeModel}
        <select
          className="ob-select ob-settings-select"
          aria-label={copy.runtimeModel}
          value={models.some((model) => model.id === modelId) ? modelId : 'default'}
          onChange={(e) => onChange({ backendId, modelId: e.target.value, ...(thinking ? { thinking } : {}) })}
        >
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.id === 'default' ? copy.runtimeModelDefault : model.label}
            </option>
          ))}
        </select>
      </label>
      {wire ? (
        <label>
          {copy.thinking}
          <select
            className="ob-select ob-settings-select"
            aria-label={copy.thinking}
            value={thinking ?? ''}
            disabled={!accepts}
            title={accepts ? undefined : copy.thinkingUnavailable}
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
            {THINKING_DEPTHS.map((depth) => (
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
