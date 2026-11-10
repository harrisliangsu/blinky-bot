import { useEffect, useState, type ReactNode } from 'react'
import type { GitHubCommentDraft } from '../../../shared/drafts'
import './GitHubDraftCards.css'

export function GitHubDraftCards({ sessionId }: { sessionId: string }): ReactNode {
  const [items, setItems] = useState<GitHubCommentDraft[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true, changed = false
    setItems([]); setError('')
    void window.openbot.githubDrafts.list(sessionId).then((result) => {
      if (!active) return
      if (!result.ok) setError(result.error ?? '草稿读取失败。')
      else if (!changed) setItems(result.drafts ?? [])
      else setItems((previous) => [...(result.drafts ?? []).filter((d) => !previous.some((item) => item.id === d.id)), ...previous])
    }).catch(() => { if (active) setError('草稿读取失败。') })
    const stop = window.openbot.on((event) => {
      if (event.type !== 'github-draft-updated' || event.draft.sessionId !== sessionId) return
      changed = true
      setItems((previous) => [...previous.filter((d) => d.id !== event.draft.id), event.draft])
    })
    return () => { active = false; stop() }
  }, [sessionId])
  async function act(draft: GitHubCommentDraft, action: 'send' | 'cancel'): Promise<void> {
    if (busy) return
    setBusy(draft.id); setError('')
    try {
      const result = await window.openbot.githubDrafts.act(draft.id, sessionId, action)
      if (!result.ok) setError(result.error ?? '操作未完成。')
      else if (result.draft) setItems((previous) => previous.map((item) => item.id === draft.id ? result.draft! : item))
    } catch { setError('操作未完成，请检查草稿状态。') }
    finally { setBusy(null) }
  }
  return <>
    {items.map((draft) => <section className="ob-github-draft" key={draft.id} aria-label="GitHub 评论草稿">
      <strong>GitHub 评论{draft.status === 'sent' ? '已发送' : draft.status === 'cancelled' ? '已取消' : '草稿'}</strong>
      <p className="ob-github-draft-target">{draft.owner}/{draft.repo} · #{draft.issueNumber}</p>
      <div className="ob-github-draft-body">{draft.body}</div>
      {draft.status === 'draft' ? <div className="ob-github-draft-actions">
        <button type="button" className="ob-btn ob-btn-sm" disabled={!!busy} onClick={() => void act(draft, 'cancel')}>取消草稿</button>
        <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" disabled={!!busy} onClick={() => void act(draft, 'send')}>确认发送</button>
      </div> : null}
      {draft.status === 'sending' ? <p>正在发送…</p> : null}
      {draft.status === 'uncertain' ? <p role="alert">发送结果未确认，请先到 GitHub 检查是否已经发布。应用不会自动重发。</p> : null}
      {draft.status === 'sent' && draft.remoteUrl ? <p>已收到 GitHub 回执：{draft.remoteUrl}</p> : null}
      {draft.feedbackStatus === 'uncertain' ? <p role="alert">Bot 是否处理了这条结果尚未确认；请检查聊天后再继续。</p> : null}
    </section>)}
    {error ? <p role="alert">{error}</p> : null}
  </>
}
