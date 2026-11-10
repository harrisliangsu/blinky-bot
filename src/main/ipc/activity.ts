import type { ActivityItem, AgentTask } from '../../shared/types'
import { summariseTask } from '../../shared/activity'
import { clearActivity, listActivity, markActivityRead } from '../store/activity'
import { getTask, listTasks, tasksLoadWasIncomplete } from '../store/tasks'
import { unreadableRecord } from './readFailure'
import { cancelBackgroundTask, startBackgroundTask } from '../tasks'
import { answerTaskClarification, cancelTaskClarification, listTaskClarifications } from '../tasks/clarifications'
import { CHANNELS } from './channels'
import { emptyArray, handle, handleVoid, nullResult } from './handler'
import { asId, asString } from './validate'

export function registerActivityIpc(): void {
  handle(CHANNELS.tasksClarifications, ([taskId]) => listTaskClarifications(taskId === undefined ? undefined : asId(taskId)), unreadableRecord)
  handle(CHANNELS.tasksAnswerClarification, async ([id, answers]) => {
    try {
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('invalid answers')
      return { ok: true as const, request: await answerTaskClarification(asId(id), answers as Record<string, string[]>) }
    } catch {
      return { ok: false as const, error: '回答未被接收，请确认问题仍在等待回答后重试。' }
    }
  }, () => ({ ok: false as const, error: '回答未被接收，请稍后重试。' }))
  handle(CHANNELS.tasksCancelClarification, async ([id]) => {
    try { return { ok: true as const, request: await cancelTaskClarification(asId(id)) } }
    catch { return { ok: false as const, error: '问题未能取消，请核对当前状态。' } }
  }, () => ({ ok: false as const, error: '问题未能取消。' }))
  handle<ActivityItem[]>(CHANNELS.activityList, () => listActivity(), emptyArray)
  handleVoid(CHANNELS.activityMarkRead, ([id]) => markActivityRead(id === undefined ? undefined : asId(id)))
  handleVoid(CHANNELS.activityClear, () => clearActivity())

  handle<AgentTask[]>(CHANNELS.tasksList, () => {
    if (tasksLoadWasIncomplete()) return unreadableRecord()
    return listTasks()
  }, unreadableRecord)
  handle(CHANNELS.tasksSummaries, ([botId]) => {
    if (tasksLoadWasIncomplete()) return unreadableRecord()
    const id = botId === undefined ? undefined : asId(botId)
    return listTasks().filter(task => !id || task.botId === id || task.requesterBotId === id).map(summariseTask)
  }, unreadableRecord)
  handle(CHANNELS.tasksGet, ([id]) => {
    if (tasksLoadWasIncomplete()) return unreadableRecord()
    return getTask(asId(id))
  }, unreadableRecord)
  handle<AgentTask | null>(CHANNELS.tasksCreate, ([botId, prompt, title]) => {
    const id = asId(botId)
    const body = asString(prompt, 100_000).trim()
    const label = title === undefined ? body.slice(0, 80) : asString(title, 200).trim()
    return startBackgroundTask(id, body, label)
  }, nullResult)
  handle<AgentTask | null>(
    CHANNELS.tasksCancel,
    ([taskId]) => cancelBackgroundTask(asId(taskId)),
    nullResult
  )
}
