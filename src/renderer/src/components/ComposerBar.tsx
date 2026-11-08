import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { useAppState } from '../state'
import { useBotChinese } from './BotUiLanguage'
import { IconMic, IconPaperclip, IconSend, IconPlus } from './Icons'

interface BarProps {
  onAttach: () => void
  attaching?: boolean
  listening: boolean
  voiceBusy: boolean
  onToggleVoice: () => void
  blocked: boolean
  canSend: boolean
  onSend: () => void
  children: ReactNode
}
export function ComposerBar({ onAttach, attaching, listening, voiceBusy, onToggleVoice, blocked, canSend, onSend, children }: BarProps): ReactNode {
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
      <button ref={trigger} type="button" className="ob-icon-btn ob-composer-plus" onClick={() => setOpen(!open)} aria-label={zh ? '添加附件' : 'Add attachments'} aria-haspopup="menu" aria-expanded={open} aria-controls="ob-composer-add-menu" disabled={blocked || attaching}><IconPlus size={19} /></button>
      {open ? <div role="menu" id="ob-composer-add-menu" className="ob-composer-add-menu">
        <button type="button" role="menuitem" onPointerDown={event => event.preventDefault()} onClick={() => { setOpen(false); trigger.current?.focus(); onAttach() }}><IconPaperclip size={15} />{zh ? '添加文件' : 'Attach files'}</button>
        {window.openbot.environment?.kind === 'browser' ? <p className="ob-hint ob-attach-hint">{zh ? '可选择照片或文件，每个最多 6 MB。粘贴图片可长按输入框；浏览器不提供图片时请添加文件。' : 'Choose photos or files up to 6 MB each. Paste images in the input, or choose a file if your browser does not expose the clipboard image.'}</p> : null}
      </div> : null}
    </div>
    {children}
    <div className="ob-composer-right">
      <button type="button" className={`ob-icon-btn${listening ? ' is-active' : ''}`} onClick={onToggleVoice} aria-pressed={voiceBusy} aria-label={voiceBusy ? (zh ? '结束语音输入' : 'Finish voice input') : (zh ? '开始语音输入' : 'Start voice input')} title={zh ? '在本机识别语音' : 'On-device voice input'} disabled={blocked}><IconMic size={18} /></button>
      <button type="button" className="ob-icon-btn ob-composer-send" onClick={onSend} disabled={!canSend} aria-label={copy.chat.send} title={`${copy.chat.send} · ${shortcut === 'mod-enter' ? copy.general.sendMod : copy.general.sendEnter}`}><IconSend size={17} /></button>
    </div>
  </div>
}
