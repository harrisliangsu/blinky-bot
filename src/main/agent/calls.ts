/**
 * Runs the tool calls one orchestrated turn asked for.
 *
 * Only reached when we own the loop. An agent CLI executes its own tools and its
 * adapter renders that as text, so nothing here ever runs twice.
 *
 * `handoff` is special: it ends the turn rather than producing a result the same
 * bot continues from, because the floor has moved to someone else.
 */

import type { Message } from '../../shared/types'
import type { TurnInput, TurnResult } from './turn'
import type { TurnMode } from './backendMode'
import { addToolMessage } from './messages'
import { broadcast } from './events'
import { executeCall, toolAllowedForBot } from './execute'
import { performHandoff, takePendingNote } from './handoff'
import { sessions } from './sessionGateway'
import { isTracedBackgroundRun } from './executionAgent'
import { iterationsUsed } from './limits'
import { mustDelegateTool } from './inlineToolBudget'
import { taskJudgmentAllows, taskJudgmentScope } from './taskJudgmentScope'

export async function runCalls(
  input: TurnInput,
  message: Message,
  intent: string,
  mode: TurnMode
): Promise<TurnResult> {
  const { session, bot, settings, signal } = input
  const judgment=taskJudgmentScope(session.id)
  if(judgment&&(message.toolCalls??[]).some(c=>!taskJudgmentAllows(session.id,c.name,c.args??{}))){judgment.attemptedTool=true;return {status:'final',message,mode}}

  for (const call of message.toolCalls ?? []) {
    if (signal.aborted) return { status: 'aborted', message, mode }

    if (mustDelegateTool({ iteration: iterationsUsed(session.id), delegated: isTracedBackgroundRun(session.id), executorConfigured: Boolean(bot.executionAgent), delegationEnabled: session.mode === 'agent' && bot.tools.includes('delegate_task'), tool: call.name })) {
      const result = { callId: call.id, name: call.name, ok: false, output: 'The inline tool-round budget is exhausted. Delegate the remaining authorized work to the independent execution agent. Include the original goal, constraints, and what has already happened; inspect the actual state before repeating any action.' }
      await addToolMessage(session, bot.id, result)
      broadcast({ type: 'tool-result', sessionId: session.id, messageId: message.id, result })
      continue
    }

    if (call.name === 'handoff') {
      if (!(await toolAllowedForBot(bot, call.name))) {
        const result = { callId: call.id, name: call.name, ok: false, output: 'Refused: "handoff" is not enabled for this bot.' }
        await addToolMessage(session, bot.id, result)
        broadcast({ type: 'tool-result', sessionId: session.id, messageId: message.id, result })
        continue
      }
      const handoff = await performHandoff(session, bot, call)
      const result = {
        callId: call.id,
        name: call.name,
        ok: handoff.ok,
        output: handoff.message
      }
      await addToolMessage(session, bot.id, result)
      broadcast({ type: 'tool-result', sessionId: session.id, messageId: message.id, result })
      if (!handoff.ok) continue

      // The message is already in the transcript, so this only persists the edit.
      await sessions.update(session, (fresh) => {
        message.handoffTo = handoff.toBotId
        const at = fresh.messages.findIndex((item) => item.id === message.id)
        if (at >= 0) fresh.messages[at] = { ...fresh.messages[at], handoffTo: handoff.toBotId }
      })
      return {
        status: 'handoff',
        message,
        mode,
        note: takePendingNote(session.id) ?? handoff.note,
        request: handoff.reason
      }
    }

    await addToolMessage(
      session,
      bot.id,
      await executeCall({
        session,
        bot,
        settings,
        call,
        messageId: message.id,
        signal,
        intent
      })
    )
  }

  return signal.aborted ? { status: 'aborted', message, mode } : { status: 'tools', message, mode }
}
