/**
 * IPC for `OpenBotApi.routines`. Reads come straight from the store; replay
 * and recording are delegated to the agent loop, and whatever the recorder
 * hands back is persisted here so a routine is never lost.
 */

import type { Routine } from '../../shared/types'
import { getBot } from '../store/bots'
import {
  getRoutine,
  listRoutines,
  markRoutineRun,
  removeRoutine,
  saveRoutine,
  updateRoutineDurable
} from '../store/routines'
import { getSession } from '../store/sessions'
import { AGENT_UNAVAILABLE, loopFn } from './agentRuntime'
import { broadcast } from './broadcast'
import { CHANNELS } from './channels'
import { emptyArray, handle, handleEvent, handleVoid, nullResult } from './handler'
import { asId, asOptionalId, asPatch, asString } from './validate'
import { isValidCron } from '../routines/cron'
import { getRoutineLauncherStatus } from '../app/routineLauncher'
import { getOrCreateWebhookSecret } from '../routines/webhookSecrets'
import { syncWebhookListener, webhookStatus, webhookPort } from '../routines/webhookServer'
import { listRoutineRuns } from '../routines/runs'
import { runRoutineNow } from '../routines/scheduler'
import { ensureBotHome } from '../store/botHome'
import { authorizeFolderObservation, createFolderWatch, createOnceInstruction, createScheduledInstruction, type RoutineNotification } from '../routines/create'
import { isValidScheduleOptions } from '../routines/cron'

/**
 * Only the four fields the UI can edit survive the bridge. Identity, the
 * recorded steps and the creation time are ours — a patch cannot reach them,
 * so a malformed or hostile payload can never rewrite what was recorded.
 */
function editablePatch(value: unknown): Partial<Routine> {
  const patch = asPatch<Routine>(value)
  const out: Partial<Routine> = {}
  if (patch.notifyPolicy !== undefined) {
    if (!['always','on_change','quiet'].includes(patch.notifyPolicy)) throw new TypeError('通知策略无效。')
    out.notifyPolicy = patch.notifyPolicy
  }

  if (typeof patch.name === 'string') {
    const name = patch.name.trim().slice(0, 200)
    if (name) out.name = name
  }
  if (typeof patch.description === 'string') {
    out.description = patch.description.slice(0, 4000)
  }
  if (typeof patch.instruction === 'string') {
    const instruction = patch.instruction.trim().slice(0, 20_000)
    if (!instruction) throw new TypeError('A routine instruction cannot be empty.')
    out.instruction = instruction
  }
  if (patch.replayMode === 'literal' || patch.replayMode === 'adaptive') {
    out.replayMode = patch.replayMode
  }
  // The store's normaliser has the last word on the trigger's shape.
  if (typeof patch.trigger === 'object' && patch.trigger !== null && !Array.isArray(patch.trigger)) {
    if (patch.trigger.kind === 'manual') out.trigger = { kind: 'manual' }
    else if (patch.trigger.kind === 'schedule' && typeof patch.trigger.cron === 'string' && isValidCron(patch.trigger.cron)) {
      if (!isValidScheduleOptions(patch.trigger)) throw new TypeError('时区或允许偏移分钟数无效。')
      out.trigger = { kind: 'schedule', cron: patch.trigger.cron.trim(),
        ...(patch.trigger.tz ? { tz: patch.trigger.tz } : {}),
        ...(patch.trigger.earlyMinutes !== undefined ? { earlyMinutes: patch.trigger.earlyMinutes } : {}),
        ...(patch.trigger.lateMinutes !== undefined ? { lateMinutes: patch.trigger.lateMinutes } : {}) }
    } else if (patch.trigger.kind === 'once' && Number.isSafeInteger(patch.trigger.at) && Number(patch.trigger.at) >= 0 && isValidScheduleOptions(patch.trigger)) {
      out.trigger = { kind: 'once', at: patch.trigger.at,
        ...(patch.trigger.lateMinutes !== undefined ? { lateMinutes: patch.trigger.lateMinutes } : {}) }
    } else if (patch.trigger.kind === 'folder_change' && typeof patch.trigger.path === 'string' && patch.trigger.path.trim()) {
      out.trigger = { kind: 'folder_change', path: patch.trigger.path.trim() }
    } else {
      throw new TypeError('A scheduled routine needs a valid five-field cron expression.')
    }
  }
  return out
}

async function withRuns(routine: Routine | null): Promise<Routine | null> {
  if (!routine) return null
  try { return { ...routine, runs: (await listRoutineRuns(routine.id)).slice(0, 100) } }
  catch { return { ...routine, runsError: '运行记录无法读取；未将缺失记录视为成功，请检查本地存储。' } }
}

export function registerRoutineIpc(): void {
  handle<Routine | null>('openbot:routines:createInstruction', async ([botId, name, instruction, trigger, policy]) => {
    const owner = asId(botId), session = ensureBotHome(owner)
    if (!session) throw new Error('无法打开此 Bot 的例程对话。')
    const title = asString(name, 200), body = asString(instruction, 20_000)
    const timing = editablePatch({ trigger }).trigger
    if (!timing || !['schedule', 'once', 'folder_change'].includes(timing.kind)) throw new TypeError('请选择定时、一次性或文件夹变化。')
    if (policy !== undefined && !['always', 'quiet', 'on_change'].includes(String(policy))) throw new TypeError('通知策略无效。')
    const notification = policy as RoutineNotification | undefined
    if (timing.kind === 'schedule') return createScheduledInstruction(session.id, owner, title, body, timing.cron!, { tz: timing.tz, earlyMinutes: timing.earlyMinutes, lateMinutes: timing.lateMinutes, notifyPolicy: notification })
    if (timing.kind === 'once') return createOnceInstruction(session.id, owner, title, body, timing.at!, timing.lateMinutes, notification)
    return createFolderWatch(session.id, owner, title, body, timing.path!, notification)
  }, nullResult)
  // A credential may be revealed only to the app's own top-level UI, never
  // through the Agent's native bridge or MCP tools.
  handleEvent('openbot:routines:webhookSetup', async (_event, [id]) => {
    const routine = getRoutine(asId(id))
    if (!routine || routine.trigger.kind !== 'webhook') throw new Error('Webhook routine not found.')
    const secret = await getOrCreateWebhookSecret(routine.id)
    syncWebhookListener()
    return { url: `http://127.0.0.1:${webhookPort()}/webhooks/${routine.id}`, secret, state: webhookStatus() }
  }, () => null)
  handle('openbot:routines:backgroundStatus', () => getRoutineLauncherStatus(), () => ({ state: 'unavailable' as const }))
  handle<Routine[]>(CHANNELS.routinesList, ([botId]) => listRoutines(asOptionalId(botId)), emptyArray)

  handle<Routine | null>(CHANNELS.routinesGet, ([id]) => withRuns(getRoutine(asId(id))), nullResult)

  handle<Routine | null>(
    CHANNELS.routinesUpdate,
    async ([id, patch]) => {
      const routineId = asId(id)
      const input = editablePatch(patch), existing = getRoutine(routineId)
      if (input.trigger?.kind === 'folder_change') {
        if (!existing?.instruction) throw new Error('文件夹变化例程需要任务指令。')
        const session = ensureBotHome(existing.botId)
        if (!session) throw new Error('无法读取所属 Bot 对话。')
        input.trigger.path = await authorizeFolderObservation(session.id, existing.botId, input.trigger.path!)
      }
      const updated = await updateRoutineDurable(routineId, input)
      if (!updated) throw new TypeError(`unknown routine: ${routineId}`)
      return withRuns(updated)
    },
    nullResult
  )

  handleVoid(CHANNELS.routinesRemove, ([id]) => {
    removeRoutine(asId(id))
  })

  handle<boolean>(CHANNELS.routinesRun, ([id, sessionId]) => runRoutineNow(asId(id), asId(sessionId)), () => false)

  handleVoid(CHANNELS.routinesStartRecording, async ([botId, name]) => {
    const id = asId(botId)
    const label = asString(name, 200).trim() || 'New routine'
    if (!getBot(id)) throw new TypeError(`unknown bot: ${id}`)
    const start = await loopFn('startRecording')
    if (!start) {
      broadcast({ type: 'recording-state', state: 'idle', stepCount: 0 })
      return
    }
    await start(id, label)
  })

  handle<Routine | null>(
    CHANNELS.routinesStopRecording,
    async () => {
      const stop = await loopFn('stopRecording')
      if (!stop) {
        broadcast({ type: 'recording-state', state: 'idle', stepCount: 0 })
        return null
      }
      const routine = await stop()
      if (!routine) return null
      // Persist regardless of whether the recorder already saved it.
      return saveRoutine(routine)
    },
    nullResult
  )
}
