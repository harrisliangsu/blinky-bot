import { actOnXDraft, listXDrafts } from '../connectors/xDrafts'
import { handleEvent } from './handler'

/** Only the trusted application window can publish or cancel a local post draft. */
export function registerXDraftIpc(): void {
  handleEvent('openbot:x-drafts:list', async (_event, [sessionId]) => {
    if (typeof sessionId !== 'string') return { ok: false, error: '无法读取帖子草稿。' }
    try { return { ok: true, drafts: await listXDrafts(sessionId) } } catch { return { ok: false, error: '帖子草稿读取失败，请检查本地数据。' } }
  }, () => ({ ok: false, error: '无法读取帖子草稿。' }))
  handleEvent('openbot:x-drafts:act', async (_event, [id, sessionId, action]) => {
    if (typeof id !== 'string' || typeof sessionId !== 'string' || (action !== 'send' && action !== 'cancel')) return { ok: false, error: '无效操作。' }
    try { return { ok: true, draft: await actOnXDraft(id, sessionId, action) } } catch { return { ok: false, error: '操作未完成，请检查 X 连接、账户和草稿状态。' } }
  }, () => ({ ok: false, error: '操作未完成。' }))
}
