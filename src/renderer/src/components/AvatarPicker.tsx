import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import { AVATAR_COLORS, AVATAR_SHAPES, avatarColor, avatarShape, type AvatarColorId, type AvatarShapeId } from '../../../shared/botAvatars'
import { BotAvatar } from './BotAvatar'
import { useBotChinese } from './BotUiLanguage'
import './AvatarPicker.css'

/** Roving radio focus; vertical arrows follow the actual responsive grid. */
function moveChoice(event: KeyboardEvent<HTMLDivElement>): void {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  if (index < 0) return
  event.preventDefault()
  const columns = getComputedStyle(event.currentTarget).gridTemplateColumns.split(' ').length
  const offset = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -columns : columns
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + offset + buttons.length) % buttons.length
  buttons[next]?.focus()
  buttons[next]?.click()
}

interface AvatarPickerProps {
  shape?: string
  color?: string
  onChange: (shape: AvatarShapeId, color: AvatarColorId) => void
}

export function AvatarPicker({ shape, color, onChange }: AvatarPickerProps): ReactNode {
  const zh = useBotChinese()
  const selectedShape = avatarShape(shape), selectedColor = avatarColor(color)
  return <div className="ob-avatar-picker">
    <div className="ob-avatar-picker-label"><span>{zh ? '头像' : 'Avatar'}</span><small>{!shape ? (zh ? '保留原头像' : 'Original avatar retained') : zh ? AVATAR_SHAPES.find(item => item.id === selectedShape)?.name : AVATAR_SHAPES.find(item => item.id === selectedShape)?.en}</small></div>
    <div className="ob-avatar-shapes" role="radiogroup" aria-label={zh ? '头像造型' : 'Avatar shape'} onKeyDown={moveChoice}>
      {AVATAR_SHAPES.map((item, index) => <button key={item.id} type="button" role="radio" aria-label={zh ? item.name : item.en} aria-checked={!!shape && selectedShape === item.id} tabIndex={shape ? (selectedShape === item.id ? 0 : -1) : (index === 0 ? 0 : -1)} className="ob-avatar-choice" data-shape={item.id} onClick={() => onChange(item.id, selectedColor.id)}>
        <BotAvatar bot={{ name: item.name, emoji: '', color: selectedColor.hex, avatarShape: item.id, avatarColor: selectedColor.id }} size="lg" animate={false} />
      </button>)}
    </div>
    <div className="ob-avatar-picker-label"><span>{zh ? '颜色' : 'Colour'}</span><small>{!shape ? '—' : zh ? selectedColor.name : selectedColor.en}</small></div>
    <div className="ob-avatar-colors" role="radiogroup" aria-label={zh ? '头像颜色' : 'Avatar colour'} onKeyDown={moveChoice}>
      {AVATAR_COLORS.map((item, index) => <button key={item.id} type="button" role="radio" aria-label={zh ? item.name : item.en} aria-checked={!!shape && selectedColor.id === item.id} tabIndex={shape ? (selectedColor.id === item.id ? 0 : -1) : (index === 0 ? 0 : -1)} className="ob-avatar-color" data-color={item.id} style={{ '--avatar-swatch': item.hex } as CSSProperties} onClick={() => onChange(selectedShape, item.id)}><span aria-hidden="true">{shape && selectedColor.id === item.id ? '✓' : ''}</span></button>)}
    </div>
  </div>
}
