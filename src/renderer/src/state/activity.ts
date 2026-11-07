import type { AgentTask } from '../../../shared/types'
import { summariseTask } from '../../../shared/activity'
import { bridge, errText } from './bridge'
import { store } from './core'

export async function loadActivity(): Promise<void> {
  try {
    const [activity, tasks] = await Promise.all([bridge().activity.list(), bridge().tasks.summaries()])
    store.patch({ activity, tasks })
  } catch (error) { store.toast(errText(error), 'error') }
}

/*
 * Both of these are called as `void markActivityRead()` from the inbox buttons,
 * so a rejected IPC call had nowhere to land: an unhandled rejection, no toast,
 * and a button that silently does nothing while the list keeps its unread marks.
 * Catching here matches every sibling in activity/rooms/groups state.
 */
export async function markActivityRead(id?: string): Promise<void> {
  try {
    await bridge().activity.markRead(id)
    store.patch({ activity: store.getState().activity.map((item) => !id || item.id === id ? { ...item, read: true } : item) })
  } catch (error) { store.toast(errText(error), 'error') }
}

export async function clearActivity(): Promise<void> {
  try {
    await bridge().activity.clear()
    store.patch({ activity: [] })
  } catch (error) { store.toast(errText(error), 'error') }
}

export async function createBackgroundTask(botId: string, prompt: string, title?: string): Promise<AgentTask | null> {
  try {
    const task = await bridge().tasks.create(botId, prompt, title)
    if (task) store.patch({ tasks: [summariseTask(task), ...store.getState().tasks.filter((item) => item.id !== task.id)] })
    return task
  } catch (error) {
    store.toast(errText(error), 'error')
    return null
  }
}

export async function cancelBackgroundTask(id: string): Promise<void> {
  try {
    const task = await bridge().tasks.cancel(id)
    if (task) store.patch({ tasks: store.getState().tasks.map((item) => item.id === task.id ? summariseTask(task) : item) })
  } catch (error) { store.toast(errText(error), 'error') }
}
