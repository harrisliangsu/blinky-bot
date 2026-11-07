import type { ReactNode } from 'react'
import { useBotChinese } from './BotUiLanguage'
import { AvatarPicker } from './AvatarPicker'
import { BotAvatar } from './BotAvatar'
import type { AvatarShapeId, AvatarColorId } from '../../../shared/botAvatars'

interface IdentityProps {
  emoji: string
  avatarShape?: AvatarShapeId | ''
  avatarColor?: AvatarColorId | ''
  onAvatar: (shape: AvatarShapeId | '', color: AvatarColorId | '') => void
  name: string
  onName: (name: string) => void
  color: string
  description: string
  onDescription: (description: string) => void
  systemPrompt: string
  onSystemPrompt: (systemPrompt: string) => void
}

/** Who the bot is: face, name, colour, and the persona it runs with. */
export function BotEditorIdentity({
  emoji,
  avatarShape,
  avatarColor,
  onAvatar,
  name,
  onName,
  color,
  description,
  onDescription,
  systemPrompt,
  onSystemPrompt
}: IdentityProps): ReactNode {
  const zh = useBotChinese()
  return (
    <section className="ob-bot-editor-section" aria-label={zh ? '基本信息' : 'Identity'}>
      <div className="ob-bot-editor-section-head">
        <h4>{zh ? '基本信息' : 'Identity'}</h4>
        <p>{zh ? '为 Bot 设置名称、外观和工作职责。' : 'Give your bot a name, appearance and role.'}</p>
      </div>
      <div className="ob-bot-avatar-edit-preview"><BotAvatar bot={{ name, emoji, color, avatarShape, avatarColor }} size="lg" /></div>
      <AvatarPicker shape={avatarShape} color={avatarColor} onChange={onAvatar} />
      <div className="ob-bot-identity">
        <div className="ob-field ob-bot-name-field">
          <label htmlFor="ob-bot-name">{zh ? '名称' : 'Name'}</label>
          <input id="ob-bot-name" className="ob-input" value={name} onChange={(e) => onName(e.target.value)} />
        </div>
      </div>

      <div className="ob-field">
        <label htmlFor="ob-bot-desc">{zh ? '简介' : 'Description'}</label>
        <input
          id="ob-bot-desc"
          className="ob-input"
          value={description}
          placeholder={zh ? '这个 Bot 擅长做什么' : 'What this bot is for'}
          onChange={(e) => onDescription(e.target.value)}
        />
      </div>

      <div className="ob-field">
        <label htmlFor="ob-bot-prompt">{zh ? '工作指令' : 'Instructions'}</label>
        <textarea
          id="ob-bot-prompt"
          className="ob-textarea"
          rows={6}
          value={systemPrompt}
          placeholder={zh ? '描述这个 Bot 的职责和工作方式' : 'Describe this bot’s role and how it should work'}
          onChange={(e) => onSystemPrompt(e.target.value)}
        />
      </div>
    </section>
  )
}
