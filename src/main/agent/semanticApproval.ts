import type { Settings } from '../../shared/types'
import { resolveBotBinding } from '../../shared/botBinding'
import { scrubVaultJson } from '../store/vaultPrivacy'
import type { ApprovalAsk } from './approval'
import { evaluate, type PolicyVerdict } from './approvalPolicy'
import { reviewRules, semanticVerdict, SEMANTIC_REVIEW_PROMPT } from './semanticApprovalPolicy'

/** Uses only the owning Bot's existing binding; no fallback provider or credentials. */
export async function reviewApproval(ask: ApprovalAsk, settings: Settings): Promise<PolicyVerdict> {
  const manual = (reason: string): PolicyVerdict => ({ outcome: 'ask', reason })
  const rules = reviewRules(settings)
  if (!rules) return manual('natural-language rules could not be read safely')
  const controller = new AbortController()
  const signal = ask.signal ? AbortSignal.any([ask.signal, controller.signal]) : controller.signal
  let timeout: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    const work = (async (): Promise<PolicyVerdict> => {
      const [{ getSession }, { getBot }, { getBackend, runSideCall }] = await Promise.all([
        import('../store/sessions'), import('../store/bots'), import('./backendGateway')
      ])
      const session = getSession(ask.sessionId)
      const owner = ask.botId ?? (session?.botIds.length === 1 ? session.botIds[0] : undefined)
      if (!session || !owner || !session.botIds.includes(owner)) return manual('automatic review has no unambiguous owning Bot')
      const bot = getBot(owner)
      if (!bot) return manual('automatic review owner is unavailable')
      const binding = resolveBotBinding(bot, settings)
      if (settings.backends[binding.backendId]?.enabled === false) return manual('the Bot model is disabled')
      const backend = await getBackend(binding.backendId)
      if (!backend || (backend.kind === 'agent-cli' && !backend.modelOnlyChat)) return manual('the Bot model has no verified tool-free review path')
      const action = scrubVaultJson({ tool: ask.toolName, target: ask.target, args: ask.call?.args, summary: ask.summary, detail: ask.detail, preview: ask.preview })
      const actionJson = JSON.stringify(action)
      if (actionJson.length > 32_000 || JSON.stringify(rules).length > 40_000) return manual('automatic review context is too large')
      if (signal.aborted) return manual('automatic review cancelled')
      const result = await runSideCall(binding.backendId, {
        model: binding.modelId, thinking: binding.thinking, cwd: session.cwd,
        readOnly: true, disableNativeTools: true, signal,
        messages: [{ role: 'system', content: SEMANTIC_REVIEW_PROMPT }, { role: 'user', content: JSON.stringify({ rules, action }) }]
      }, settings)
      if (signal.aborted || !result || result.calls.length) return manual('automatic review is unavailable or cancelled')
      const baseline = evaluate({ ...settings, semanticPermissionRules: [] }, ask.toolName, ask.target, new Set(), false, false, ask.localExecution, ask.call)
      return semanticVerdict(result.text, rules, actionJson, baseline)
    })()
    const expired = new Promise<PolicyVerdict>(resolve => {
      timeout = setTimeout(() => { controller.abort(); resolve(manual('automatic review timed out')) }, 15_000)
    })
    const cancelled = new Promise<PolicyVerdict>(resolve => {
      onAbort = () => resolve(manual('automatic review cancelled'))
      if (ask.signal?.aborted) onAbort()
      else ask.signal?.addEventListener('abort', onAbort, { once: true })
    })
    return await Promise.race([work, expired, cancelled])
  } catch {
    return manual('automatic review is unavailable')
  } finally {
    if (timeout) clearTimeout(timeout)
    if (onAbort) ask.signal?.removeEventListener('abort', onAbort)
    controller.abort()
  }
}
