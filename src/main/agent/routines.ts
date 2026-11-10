/**
 * Routines: the record & replay entry points used by IPC.
 *
 * Recording lives in `recorder.ts`, replay in `replay.ts`; this module runs a replay as a
 * proper session turn — cancellable, narrated into a real assistant message, and ended
 * with the same `done` event as any other turn.
 */

import type { Routine } from '../../shared/types'
import * as cancel from './cancel'
import { assistantMessage, begin, commit } from './messages'
import { bots, sessions } from './sessionGateway'
import { broadcast, broadcastError } from './events'
import { cancelPending } from './approval'
import { errorMessage, isAbortError } from './errors'
import { replayRoutine } from './replay'
import { routines } from './routineGateway'
import { settingsStore } from './settingsGateway'
import { loopFn } from '../ipc/agentRuntime'

export {
  isRecording,
  recordingBotId,
  recordingState,
  startRecording,
  stopRecording
} from './recorder'
export { replayRoutine } from './replay'

export async function runRoutine(routineId: string, sessionId: string): Promise<void> {
  const session = await sessions.get(sessionId)
  if (!session) {
    broadcastError(sessionId, 'Cannot run the routine: this session no longer exists.')
    broadcast({ type: 'done', sessionId })
    return
  }

  if (cancel.isRunning(sessionId)) {
    broadcastError(sessionId, 'This session is already busy. Stop it before running a routine.')
    return
  }

  const routine = await routines.get(routineId)
  if (!routine) {
    broadcastError(sessionId, `Routine "${routineId}" was not found.`)
    broadcast({ type: 'done', sessionId })
    return
  }

  if (routine.instruction) {
    if (session.activeBotId !== routine.botId) {
      broadcastError(sessionId, 'Open the Bot that owns this routine before running it.')
      return
    }
    const send = await loopFn('sendMessage')
    if (!send) { broadcastError(sessionId, 'The Bot runtime is unavailable.'); return }
    await send(sessionId, `[Routine: ${routine.name}]\n\n${routine.instruction}`)
    return
  }

  const bot = (await bots.get(routine.botId)) ?? (await bots.get(session.activeBotId))
  if (!bot) {
    broadcastError(sessionId, `The bot this routine belongs to (${routine.botId}) no longer exists.`)
    broadcast({ type: 'done', sessionId })
    return
  }

  const settings = await settingsStore.get()
  const controller = cancel.start(sessionId)
  const message = assistantMessage(bot)
  begin(sessionId, message)

  try {
    const report = await replayRoutine({
      routine,
      session,
      bot,
      settings,
      messageId: message.id,
      signal: controller.signal
    })
    message.content = `${report.transcript}\n${summarise(routine, report.completed, report.failed, report.aborted)}`
    if (report.failed > 0) message.error = `${report.failed} step(s) failed`
  } catch (err) {
    if (!isAbortError(err)) {
      const detail = errorMessage(err)
      message.content = `${message.content}\nRoutine stopped: ${detail}`
      message.error = detail
      broadcastError(sessionId, `Routine "${routine.name}" failed: ${detail}`)
    }
  } finally {
    await commit(session, message)
    cancelPending(sessionId, 'routine ended')
    cancel.finish(sessionId, controller)
    broadcast({ type: 'session-updated', session })
    broadcast({ type: 'done', sessionId })
  }
}

function summarise(routine: Routine, completed: number, failed: number, aborted: boolean): string {
  if (aborted) return `Stopped: ${completed} of ${routine.steps.length} steps completed.`
  return failed > 0
    ? `Finished with problems: ${completed} completed, ${failed} failed.`
    : `Finished: all ${completed} steps completed.`
}
