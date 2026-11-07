import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { useAppState } from '../state'
import { useBotChinese } from './BotUiLanguage'
import { IconMic, IconPaperclip, IconSend, IconPlus } from './Icons'

interface BarProps {
  onAttach: () => void
  listening: boolean
  voiceBusy: boolean
  onToggleVoice: () => void
  blocked: boolean
  canSend: boolean
  onSend: () => void
  children: ReactNode
}
export function ComposerBar({ onAttach, listening, voiceBusy, onToggleVoice, blocked, canSend, onSend, children }: BarProps): ReactNode {
  const copy = useSettingsCopy()
  const zh = useBotChinese()
  const shortcut = useAppState().settings?.sendShortcut ?? 'enter'
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus()
    const close = (e: MouseEvent): void => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  return <div className="ob-composer-bar">
    <div className="ob-composer-add" ref={root} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false) }} onKeyDown={(e) => {
      if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus() }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!open) setOpen(true); else root.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus() }
    }}>
      <button ref={trigger} type="button" className="ob-icon-btn ob-composer-plus" onClick={() => setOpen(!open)} aria-label={zh ? '添加附件' : 'Add attachments'} aria-haspopup="menu" aria-expanded={open} aria-controls="ob-composer-add-menu" disabled={blocked}><IconPlus size={19} /></button>
      {open ? <div role="menu" id="ob-composer-add-menu" className="ob-composer-add-menu">
        <button type="button" role="menuitem" onClick={() => { setOpen(false); trigger.current?.focus(); onAttach() }}><IconPaperclip size={15} />{zh ? '添加文件' : 'Attach files'}</button>
      </div> : null}
    </div>
    {children}
    <div className="ob-composer-right">
      <button type="button" className={`ob-icon-btn${listening ? ' is-active' : ''}`} onClick={onToggleVoice} aria-pressed={voiceBusy} aria-label={voiceBusy ? (zh ? '结束语音输入' : 'Finish voice input') : (zh ? '开始语音输入' : 'Start voice input')} title={zh ? '在本机识别语音' : 'On-device voice input'} disabled={blocked}><IconMic size={18} /></button>
      <button type="button" className="ob-icon-btn ob-composer-send" onClick={onSend} disabled={!canSend} aria-label={copy.chat.send} title={`${copy.chat.send} · ${shortcut === 'mod-enter' ? copy.general.sendMod : copy.general.sendEnter}`}><IconSend size={17} /></button>
    </div>
  </div>
}
