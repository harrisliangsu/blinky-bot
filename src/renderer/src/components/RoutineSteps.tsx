import type { ReactNode } from 'react'
import type { RoutineStep } from '../../../shared/types'
import { resolveSettingsLang } from '../lib/settingsCopy'
import { useAppState } from '../state'
import { pngSrc, summarizeArgs } from '../lib/format'
import './RoutineSteps.css'

interface RoutineStepsProps {
  steps: RoutineStep[]
  emptyText: string
}

/** Ordered capture of what a routine does, one row per step. */
export function RoutineSteps({ steps, emptyText }: RoutineStepsProps): ReactNode {
  const { settings } = useAppState()
  const zh = resolveSettingsLang(settings?.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'
  if (steps.length === 0) return <p className="ob-hint">{emptyText}</p>

  return (
    <ol className="ob-steps">
      {steps.map((step, i) => {
        const params = step.params ? summarizeArgs(step.kind, step.params) : ''
        return (
          <li key={step.id} className="ob-step">
            <span className="ob-step-index">{i + 1}</span>
            {step.reference ? (
              <img className="ob-step-thumb" src={pngSrc(step.reference)} alt={zh ? `第 ${i + 1} 步的参考截图` : `Reference capture for step ${i + 1}`} />
            ) : null}
            <span className="ob-step-body">
              <span className="ob-step-head">
                <span className="ob-pill">{step.kind}</span>
                {params ? <span className="ob-step-params">{params}</span> : null}
              </span>
              <span className="ob-step-intent">{step.intent || (zh ? '没有录制描述。' : 'No description captured.')}</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}
