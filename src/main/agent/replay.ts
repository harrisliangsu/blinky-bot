/**
 * Routine replay.
 *
 * `literal`  — re-execute the captured parameters as they were recorded.
 * `adaptive` — hand the model each step's intent plus a fresh screenshot and let it
 *              re-derive the action, which survives a UI that has since moved.
 *
 * Both paths run through `executeCall`, so the approval gate, the mode rules and the
 * computer-use permission apply exactly as they do in a normal turn.
 */

import type { Bot, Routine, RoutineStep, Session, Settings, ToolCall } from '../../shared/types'
import type { ProviderMessage, ProviderPart } from './contracts'
import { imagePart, textPart } from './contracts'
import { availableTools } from './context'
import { broadcast } from './events'
import { executeCall } from './execute'
import { newId } from './ids'
import { routines } from './routineGateway'
import { runSideCall } from './backendGateway'
import { schemasFor } from './toolGateway'
import { toolsVisibleToBot } from '../apps/sharedAccess'
import { stringifySafe } from './json'
import { TOOL_PARAM_KEY } from './recorder'
import { truncate } from './text'

const KIND_TOOLS: Record<string, string> = {
  observe: 'screenshot',
  assert: 'screenshot',
  click: 'click',
  double_click: 'click',
  type: 'type_text',
  key: 'key_press',
  scroll: 'scroll',
  drag: 'drag',
  open_app: 'open_app',
  navigate: 'navigate'
}

const ADAPTIVE_SYSTEM = [
  'You are replaying one step of a recorded routine on this computer.',
  'You get the step intent, the parameters captured when it was recorded, and a screenshot',
  'of the screen as it is now. The interface may have changed since recording.',
  'Call exactly one tool that achieves the intent on the current screen.',
  'If the intent is already satisfied, call nothing and reply with the single word DONE.'
].join('\n')

export interface ReplayInput {
  routine: Routine
  session: Session
  bot: Bot
  settings: Settings
  messageId: string
  signal: AbortSignal
}

export interface ReplayReport {
  completed: number
  failed: number
  aborted: boolean
  /** Everything narrated to the renderer, so the caller can persist it as the reply. */
  transcript: string
}

export async function replayRoutine(input: ReplayInput): Promise<ReplayReport> {
  const { routine, signal } = input
  const report: ReplayReport = { completed: 0, failed: 0, aborted: false, transcript: '' }
  const narrate = (delta: string): void => {
    report.transcript += delta
    broadcast({ type: 'text-delta', sessionId: input.session.id, messageId: input.messageId, delta })
  }

  narrate(
    `Replaying "${routine.name}" — ${routine.steps.length} steps, ${routine.replayMode} mode.\n`
  )

  for (let i = 0; i < routine.steps.length; i++) {
    if (signal.aborted) {
      report.aborted = true
      break
    }
    const step = routine.steps[i]
    const label = `${i + 1}/${routine.steps.length} ${step.intent}`

    const call =
      routine.replayMode === 'adaptive'
        ? await deriveAdaptiveCall(input, step, i)
        : literalCall(step)

    if (!call) {
      narrate(`- ${label}: skipped (nothing to run)\n`)
      continue
    }

    const result = await executeCall({
      session: input.session,
      bot: input.bot,
      settings: input.settings,
      call,
      messageId: input.messageId,
      signal,
      intent: step.intent,
      record: false
    })

    if (result.ok) {
      report.completed++
      narrate(`- ${label}: done\n`)
    } else {
      report.failed++
      narrate(`- ${label}: failed — ${truncate(result.output, 200)}\n`)
      if (signal.aborted) {
        report.aborted = true
        break
      }
    }
  }

  await routines.markRun(routine.id)
  return report
}

/** Rebuild the recorded call: the tool name is stored alongside the captured arguments. */
export function literalCall(step: RoutineStep): ToolCall | null {
  const params = { ...(step.params ?? {}) }
  const recorded = params[TOOL_PARAM_KEY]
  delete params[TOOL_PARAM_KEY]

  const name = typeof recorded === 'string' && recorded ? recorded : KIND_TOOLS[step.kind]
  if (!name) return null

  const args = Object.fromEntries(Object.entries(params).filter(([key]) => !key.startsWith('_')))
  return { id: newId('call'), name, args }
}

async function deriveAdaptiveCall(
  input: ReplayInput,
  step: RoutineStep,
  index: number
): Promise<ToolCall | null> {
  const fresh = await captureScreen(input, step)
  if (input.signal.aborted) return null
  if (!fresh) return literalCall(step)

  const schemas = availableTools(
    await schemasFor(await toolsVisibleToBot(input.bot), input.bot.computerTarget),
    input.session,
    input.bot
  )

  const parts: ProviderPart[] = [
    textPart(
      `Step ${index + 1}: ${step.intent}\n` +
        `Recorded parameters (may be stale): ${stringifySafe(step.params ?? {}, 800)}\n` +
        (step.reference
          ? 'First image is the screen now; second is how it looked when recorded.'
          : 'The image is the screen now.')
    ),
    imagePart(fresh)
  ]
  if (step.reference) parts.push(imagePart(step.reference))

  const result = await runSideCall(
    input.bot.backendId,
    {
      model: input.bot.modelId,
      messages: [
        { role: 'system', content: ADAPTIVE_SYSTEM },
        { role: 'user', content: parts }
      ] satisfies ProviderMessage[],
      tools: schemas,
      temperature: 0,
      signal: input.signal
    },
    input.settings
  )

  if (!result) return literalCall(step)
  if (result.calls.length > 0) return result.calls[0]
  // "DONE" means the step is already satisfied; anything else means the model produced no
  // action, so fall back to what was recorded.
  if (/\bdone\b/i.test(result.text.trim())) return null
  return literalCall(step)
}

/** Fresh frame for adaptive replay. Returns null when this bot cannot see a screen. */
async function captureScreen(input: ReplayInput, step: RoutineStep): Promise<string | null> {
  if (!input.bot.computerUse) return null
  const result = await executeCall({
    session: input.session,
    bot: input.bot,
    settings: input.settings,
    call: { id: newId('call'), name: 'screenshot', args: {} },
    messageId: input.messageId,
    signal: input.signal,
    intent: `Look at the screen before: ${step.intent}`,
    record: false
  })
  return result.ok && result.screenshot ? result.screenshot : null
}
