import { actOnCalendarDraft, listCalendarDrafts } from '../connectors/calendarDrafts'
import { handleEvent } from './handler'

/** Only the trusted application window can confirm or cancel a calendar draft. */
export function registerCalendarDraftIpc(): void {
  handleEvent('openbot:calendar-drafts:list', async (_event, [sessionId]) => {
    if (typeof sessionId !== 'string') return { ok: false, error: '无法读取日程草稿。' }
    try { return { ok: true, drafts: await listCalendarDrafts(sessionId) } } catch { return { ok: false, error: '日程草稿读取失败，请检查本地数据。' } }
  }, () => ({ ok: false, error: '无法读取日程草稿。' }))
  handleEvent('openbot:calendar-drafts:act', async (_event, [id, sessionId, action]) => {
    if (typeof id !== 'string' || typeof sessionId !== 'string' || (action !== 'send' && action !== 'cancel')) return { ok: false, error: '无效操作。' }
    try { return { ok: true, draft: await actOnCalendarDraft(id, sessionId, action) } } catch { return { ok: false, error: '操作未完成，请检查 Calendar 连接、账户和草稿状态。' } }
  }, () => ({ ok: false, error: '操作未完成。' }))
}
