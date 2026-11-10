import { useState, type ReactNode } from 'react'
import { useAppState } from '../state'
import { useBotChinese } from './BotUiLanguage'
import './BotResourceLinks.css'

/** Open resources without changing the Bot's execution target or permissions. */
export function BotResourceLinks({ botId }: { botId: string }): ReactNode {
  const { session } = useAppState()
  const zh = useBotChinese()
  const [busy, setBusy] = useState<'computer' | 'browser' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const open = async (kind: 'computer' | 'browser'): Promise<void> => {
    if (busy || !session) return
    setBusy(kind); setError(null)
    try {
      const result = await window.openbot.bots.openResource(botId, session.id, kind)
      if (!result.ok) setError(result.error ?? (zh ? '暂时无法打开，请重试。' : 'Could not open this resource. Try again.'))
    } catch { setError(zh ? '暂时无法打开，请重试。' : 'Could not open this resource. Try again.') }
    finally { setBusy(null) }
  }
  return <section className="ob-bot-editor-section" aria-label={zh ? '电脑与浏览器' : 'Computer and browser'}>
    <div className="ob-bot-editor-section-head"><h4>{zh ? '电脑与浏览器' : 'Computer and browser'}</h4></div>
    <div className="ob-bot-resource-links">
      <button type="button" data-bot-resource="computer" disabled={Boolean(busy) || !session} onClick={() => void open('computer')}>
        <span><strong>{zh ? '我的电脑' : 'My computer'}</strong><small>{zh ? '在 Finder 中打开工作目录' : 'Open working folder in Finder'}</small></span><span aria-hidden="true">{busy === 'computer' ? '…' : '↗'}</span>
      </button>
      <button type="button" data-bot-resource="browser" disabled={Boolean(busy) || !session} onClick={() => void open('browser')}>
        <span><strong>Ego Space</strong><small>{zh ? '打开当前对话的浏览器' : 'Open this conversation’s browser'}</small></span><span aria-hidden="true">{busy === 'browser' ? '…' : '↗'}</span>
      </button>
    </div>
    {error ? <p className="ob-hint" role="alert">{error}</p> : null}
  </section>
}
