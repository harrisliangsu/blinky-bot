import { useEffect, useState, type ReactNode } from 'react'
import type { XDraft } from '../../../shared/drafts'
import { useBotChinese } from './BotUiLanguage'
import './GitHubDraftCards.css'

export function XDraftCards({ sessionId }: { sessionId: string }): ReactNode {
  const zh = useBotChinese(), [items, setItems] = useState<XDraft[]>([]), [busy, setBusy] = useState<string | null>(null), [error, setError] = useState('')
  useEffect(() => {
    let active = true, changed = false; setItems([]); setError('')
    void window.openbot.xDrafts.list(sessionId).then((result) => { if (!active) return; if (!result.ok) setError(result.error ?? (zh ? '草稿读取失败。' : 'Could not read drafts.')); else if (!changed) setItems(result.drafts ?? []); else setItems((old) => [...(result.drafts ?? []).filter((draft) => !old.some((item) => item.id === draft.id)), ...old]) }).catch(() => { if (active) setError(zh ? '草稿读取失败。' : 'Could not read drafts.') })
    const stop = window.openbot.on((event) => { if (event.type !== 'x-draft-updated' || event.draft.sessionId !== sessionId) return; changed = true; setItems((old) => [...old.filter((draft) => draft.id !== event.draft.id), event.draft]) })
    return () => { active = false; stop() }
  }, [sessionId, zh])
  async function act(draft: XDraft, action: 'send' | 'cancel'): Promise<void> {
    if (busy) return; setBusy(draft.id); setError('')
    try { const result = await window.openbot.xDrafts.act(draft.id, sessionId, action); if (!result.ok) setError(result.error ?? (zh ? '操作未完成。' : 'Action failed.')); else if (result.draft) setItems((old) => old.map((item) => item.id === draft.id ? result.draft! : item)) }
    catch { setError(zh ? '操作未完成，请检查草稿状态。' : 'Action failed; check the draft.') } finally { setBusy(null) }
  }
  return <>{items.map((draft) => <section className="ob-github-draft" key={draft.id} aria-label={zh ? 'X 帖子草稿' : 'X post draft'}>
    <strong>{draft.status === 'sent' ? (zh ? 'X 帖子已发布' : 'X post published') : draft.status === 'cancelled' ? (zh ? '帖子已取消' : 'Post cancelled') : (zh ? 'X 帖子草稿' : 'X post draft')}</strong>
    <p className="ob-github-draft-target">{zh ? '账号' : 'Account'}：@{draft.username}{draft.replyToPostId ? <><br />{zh ? '回复帖子 ID' : 'Reply to post ID'}：{draft.replyToPostId}</> : null}</p><div className="ob-github-draft-body">{draft.text}</div>
    {draft.status === 'draft' ? <div className="ob-github-draft-actions"><button type="button" className="ob-btn ob-btn-sm" disabled={!!busy} onClick={() => void act(draft, 'cancel')}>{zh ? '取消草稿' : 'Cancel draft'}</button><button type="button" className="ob-btn ob-btn-sm ob-btn-primary" disabled={!!busy} onClick={() => void act(draft, 'send')}>{zh ? '确认发布' : 'Publish post'}</button></div> : null}
    {draft.status === 'sending' ? <p>{zh ? '正在发布…' : 'Publishing…'}</p> : null}{draft.status === 'uncertain' ? <p role="alert">{zh ? '发布结果未确认，请先检查 X；应用不会自动重发。' : 'Posting is uncertain. Check X; the app will not automatically retry.'}</p> : null}
    {draft.feedbackStatus === 'uncertain' ? <p role="alert">{zh ? 'Bot 是否处理这条结果尚未确认，请检查聊天。' : 'It is unclear whether the Bot processed this receipt; check the conversation.'}</p> : null}
  </section>)}{error ? <p role="alert">{error}</p> : null}</>
}
