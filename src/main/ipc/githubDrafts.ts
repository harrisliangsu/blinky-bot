import { actOnGitHubDraft, listGitHubDrafts } from '../connectors/githubDrafts'
import { handleEvent } from './handler'

/** These channels are available to the trusted application window only. */
export function registerGitHubDraftIpc(): void {
  handleEvent('openbot:github-drafts:list', async (_event, [sessionId]) => {
    if (typeof sessionId !== 'string') return { ok: false, error: '无法读取草稿。' }
    try { return { ok: true, drafts: await listGitHubDrafts(sessionId) } } catch { return { ok: false, error: '草稿读取失败，请检查本地数据。' } }
  }, () => ({ ok: false, error: '无法读取草稿。' }))
  handleEvent('openbot:github-drafts:act', async (_event, [id, sessionId, action]) => {
    if (typeof id !== 'string' || typeof sessionId !== 'string' || (action !== 'send' && action !== 'cancel')) return { ok: false, error: '无效操作。' }
    try { return { ok: true, draft: await actOnGitHubDraft(id, sessionId, action) } }
    catch { return { ok: false, error: '操作未完成，请检查 GitHub CLI、草稿状态及网络。' } }
  }, () => ({ ok: false, error: '操作未完成。' }))
}
