import { useState, type FormEvent, type ReactNode } from 'react'
import { findBotTemplates } from '../../../shared/botTemplates'
import { snapshotBotBinding } from '../../../shared/botBinding'
import { supportsExecutionDelegation } from '../../../shared/executionAgentCapabilities'
import { createBot, openBotChat, store, useAppState } from '../state'
import { BotAvatar } from './BotAvatar'
import { AvatarPicker } from './AvatarPicker'
import { DEFAULT_AVATAR_SHAPE, DEFAULT_AVATAR_COLOR, avatarColor, type AvatarShapeId, type AvatarColorId } from '../../../shared/botAvatars'
import { useBotChinese } from './BotUiLanguage'
import { Modal } from './Modal'
import './CreateBotDialog.css'

export function CreateBotDialog({ templateId }: { templateId?: string }): ReactNode {
  const zh = useBotChinese()
  const { settings } = useAppState()
  const template = templateId ? findBotTemplates('').find((item) => item.id === templateId) : undefined
  const [name, setName] = useState(template?.name ?? '')
  const [shape, setShape] = useState<AvatarShapeId>(DEFAULT_AVATAR_SHAPE)
  const [color, setColor] = useState<AvatarColorId>(DEFAULT_AVATAR_COLOR)
  const [saving, setSaving] = useState(false)
  const close = (): void => { if (!saving) store.setModal(null) }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!name.trim() || saving) return
    setSaving(true)
    const binding = settings ? snapshotBotBinding({ backendId: settings.defaultBackendId, modelId: settings.defaultModelId, followsDefault: true }, settings) : null
    const executionAgent = binding && supportsExecutionDelegation(binding.backendId) ? { backendId: binding.backendId, modelId: binding.modelId, ...(binding.thinking ? { thinking: binding.thinking } : {}) } : undefined
    const tools = template ? [...new Set([...template.tools, ...(executionAgent ? ['delegate_task'] : [])])] : undefined
    const bot = await createBot({ name: name.trim(), emoji: template?.emoji ?? '✨', color: avatarColor(color).hex, avatarShape: shape, avatarColor: color, ...(executionAgent ? { executionAgent } : {}), ...(template ? { description: template.description, systemPrompt: template.systemPrompt, tools } : {}) })
    setSaving(false)
    if (bot) { store.setModal(null); await openBotChat(bot.id) }
  }
  return <Modal title={zh ? '创建新 Bot' : 'Create bot'} size="sm" onClose={close}>
    <form className="ob-create-bot" onSubmit={(event) => void submit(event)}>
      <div className="ob-create-bot-preview"><BotAvatar bot={{ name, emoji: '', color: avatarColor(color).hex, avatarShape: shape, avatarColor: color }} size="lg" /></div>
      {window.openbot.environment?.kind === 'browser' ? <p className="ob-hint">{zh ? '创建后可立即对话。工具和电脑控制权限在 Mac 上设置。' : 'Chat is available after creation. Set tool and computer permissions on the Mac.'}</p> : null}
      <label className="ob-sr-only" htmlFor="ob-create-bot-name">{zh ? 'Bot 名称' : 'Bot name'}</label>
      <input id="ob-create-bot-name" className="ob-input" placeholder={zh ? '给你的 Bot 起个名字' : 'Name your bot'} value={name} onChange={(event) => setName(event.target.value)} />
      <AvatarPicker shape={shape} color={color} onChange={(nextShape, nextColor) => { setShape(nextShape); setColor(nextColor) }} />
      <footer className="ob-create-bot-actions"><button type="button" className="ob-btn" onClick={close}>{zh ? '取消' : 'Cancel'}</button><button type="submit" className="ob-btn ob-btn-primary" disabled={!name.trim() || saving}>{saving ? (zh ? '创建中…' : 'Creating…') : (zh ? '创建' : 'Create')}</button></footer>
    </form>
  </Modal>
}
