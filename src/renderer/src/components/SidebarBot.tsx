import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Bot } from '../../../shared/types'
import { openBotChat, store } from '../state'
import { BotAvatar } from './BotAvatar'
import { IconPencil } from './Icons'

/** Uses only existing Bot metadata. A body portal avoids the scroll rail clipping it. */
export function SidebarBot({ bot, current, compact, conversation }: { bot: Bot; current: boolean; compact: boolean; conversation?: string }): ReactNode {
  const id = useId()
  const row = useRef<HTMLLIElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!position || !card.current) return
    const r = card.current.getBoundingClientRect()
    const top = Math.max(12, Math.min(position.top, innerHeight - r.height - 12))
    const left = Math.max(12, Math.min(position.left, innerWidth - r.width - 12))
    if (top !== position.top || left !== position.left) setPosition({ top, left })
  }, [position, bot.name, bot.description, conversation])
  const keep = (): void => { if (timer.current) clearTimeout(timer.current) }
  const show = (): void => {
    keep()
    if (!compact || !row.current) return
    const r = row.current.getBoundingClientRect()
    setPosition({ left: Math.max(12, Math.min(r.right + 8, innerWidth - Math.min(300, innerWidth - 24) - 12)), top: Math.max(12, Math.min(r.top, innerHeight - 160)) })
  }
  const hide = (): void => { keep(); timer.current = setTimeout(() => { if (!row.current?.matches(':hover, :focus-within') && !card.current?.matches(':hover')) setPosition(null) }, 150) }
  useEffect(() => {
    const reposition = (event: Event): void => {
      if (event.target instanceof Element && event.target.closest('.ob-bot-hover-card')) return
      if (row.current?.matches(':hover, :focus-within') || card.current?.matches(':hover')) show()
      else setPosition(null)
    }
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => { keep(); window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true) }
  }, [compact])
  useEffect(() => { if (!compact) setPosition(null) }, [compact])
  return <li ref={row} className={`ob-side-item${current ? ' is-current' : ''}`} onMouseEnter={show} onMouseLeave={hide}
    onFocus={show} onBlur={hide} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setPosition(null) } }}>
    <button type="button" className="ob-side-item-main" aria-label={bot.name} aria-current={current ? 'true' : undefined}
      aria-describedby={position ? id : undefined} onClick={() => { setPosition(null); void openBotChat(bot.id) }}>
      <BotAvatar bot={bot} size="sm" /><span className="ob-side-item-name">{bot.name}</span>
    </button>
    <button type="button" className="ob-icon-btn ob-side-item-action" aria-label={`Edit ${bot.name}`} onClick={() => store.setModal('bots', bot.id)}><IconPencil size={11} /></button>
    {position ? createPortal(<div ref={card} role="tooltip" id={id} className="ob-bot-hover-card" style={position} onMouseEnter={keep} onMouseLeave={hide}>
      <div><BotAvatar bot={bot} size="sm" /><strong>{bot.name}</strong></div>
      {bot.description.trim() ? <p>{bot.description}</p> : null}
      {conversation?.trim() && conversation !== bot.name ? <p>{conversation}</p> : null}
    </div>, document.body) : null}
  </li>
}
