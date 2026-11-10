import { useState, type ReactNode } from 'react'
import { store } from '../state'
export function DecisionReviewPreference({ enabled, zh }: { enabled: boolean; zh: boolean }): ReactNode {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const save = async (): Promise<void> => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const result = await window.openbot.settings.saveDecisionReview(!enabled)
      if (result.ok) store.patch({ settings: result.settings })
      else setError(result.error)
    } catch { setError(zh ? '未能保存，请重试。' : 'Could not save. Try again.') }
    finally { setBusy(false) }
  }
  return <div className="ob-set-row" data-decision-review="">
    <div className="ob-set-row-text"><div className="ob-set-row-title">{zh ? '开发决策复审' : 'Development decision review'}</div>
      <p>{zh ? '对所有 Bot 和执行 Agent 生效。在重要方案、结论或调整时使用当前可用的决策技能复审；缺少技能或调用失败时说明情况并继续。复审不会代替你的授权。' : 'Applies to all Bots and execution Agents. Review significant plans, conclusions or changes with an available decision skill. Missing skills or failed calls are reported and independent work continues. Review does not replace your consent.'}</p>
      {error ? <p role="alert">{error}</p> : null}
    </div>
    <button type="button" role="switch" className={`ob-switch${enabled ? ' is-on' : ''}`} aria-label={zh ? '开发决策复审' : 'Development decision review'} aria-checked={enabled} disabled={busy} onClick={() => void save()} />
  </div>
}
