import { useEffect, useRef, useState } from 'react'
import type { ThinkingDepth } from '../../../shared/thinking'
import { resolveBotBinding } from '../../../shared/botBinding'
import type { Bot, ComputerTarget } from '../../../shared/types'
import type { BotTemplate } from '../../../shared/botTemplates'
import type { RuntimeChoice } from './BotRuntimeFields'
import {
  cancelComputerProvision,
  createBot,
  discardComputerTarget,
  probeComputerTarget,
  provisionComputerTarget,
  removeBot,
  updateBot,
  useAppState
} from '../state'
import { DEFAULT_AVATAR_SHAPE, DEFAULT_AVATAR_COLOR, avatarColor } from '../../../shared/botAvatars'

/** A bot being edited: the saved one, or the fields a new one starts with. */
export type BotDraft = Bot | Omit<Bot, 'id' | 'createdAt' | 'updatedAt'>

type VmTarget = Extract<ComputerTarget, { kind: 'vm' }>

const emptyDraft = (): Omit<Bot, 'id' | 'createdAt' | 'updatedAt'> => ({
  name: '',
  description: '',
  systemPrompt: '',
  emoji: '✨',
  color: avatarColor(DEFAULT_AVATAR_COLOR).hex,
  avatarShape: DEFAULT_AVATAR_SHAPE,
  avatarColor: DEFAULT_AVATAR_COLOR,
  backendId: '',
  modelId: 'default',
  followsDefault: true,
  tools: ['read_file', 'list_dir', 'glob', 'grep', 'request_help', 'delegate_task'],
  computerUse: false,
  computerTarget: { kind: 'local' }
})

/** A VM target is only usable once it has an id and a control endpoint. */
export function targetIncomplete(target: ComputerTarget): boolean {
  return (
    target.kind === 'vm' &&
    (!target.vmId.trim() || !target.endpoint.trim() || (!target.hasToken && !target.token?.trim()))
  )
}

export interface BotDraftForm {
  draft: BotDraft
  set: <K extends keyof BotDraft>(key: K, value: BotDraft[K]) => void
  toggleTool: (id: string) => void
  chooseRuntime: (choice: RuntimeChoice) => void
  saving: boolean
  targetStatus: string | null
  confirmDelete: boolean
  setConfirmDelete: (confirm: boolean) => void
  save: () => Promise<void>
  provision: () => Promise<VmTarget | null>
  close: () => Promise<void>
  remove: () => Promise<void>
}

/**
 * The editor's working copy and everything that outlives a keystroke: probing
 * and saving, and the provisioned VM that has to be handed over or thrown away
 * whichever way the editor is left.
 */
function fromTemplate(template?: BotTemplate): BotDraft {
  const blank = emptyDraft()
  return template ? { ...blank, name: template.name, description: template.description, emoji: template.emoji, color: template.color, systemPrompt: template.systemPrompt, tools: [...new Set([...template.tools, 'delegate_task'])] } : blank
}

export function useBotDraft(bot: Bot | null, onClose: () => void, onSaved: (bot: Bot) => void, template?: BotTemplate): BotDraftForm {
  const { settings } = useAppState()
  const initialDraft = (): BotDraft => {
    const draft = bot ? { ...bot } : fromTemplate(template)
    const runtime = settings ? resolveBotBinding(draft, settings) : draft
    // Pin once, so editing the conversation model never changes the executor.
    return { ...draft, executionAgent: draft.executionAgent ?? { backendId: runtime.backendId, modelId: runtime.modelId, ...(runtime.thinking ? { thinking: runtime.thinking } : {}) } }
  }
  const [draft, setDraft] = useState<BotDraft>(initialDraft)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [targetStatus, setTargetStatus] = useState<string | null>(null)
  const provisionalTarget = useRef<VmTarget | null>(null)
  const editorActive = useRef(true)

  useEffect(() => {
    editorActive.current = true
    const abandoned = provisionalTarget.current
    provisionalTarget.current = null
    if (abandoned) void discardComputerTarget(abandoned)
    setDraft(initialDraft())
    setConfirmDelete(false)
    setTargetStatus(null)
  }, [bot?.id, template?.id])

  useEffect(() => () => {
    editorActive.current = false
    void cancelComputerProvision()
    const abandoned = provisionalTarget.current
    provisionalTarget.current = null
    if (abandoned) void discardComputerTarget(abandoned)
  }, [])

  const set = <K extends keyof BotDraft>(key: K, value: BotDraft[K]): void => setDraft((d) => ({ ...d, [key]: value }))

  const toggleTool = (id: string): void =>
    setDraft((d) => ({ ...d, tools: d.tools.includes(id) ? d.tools.filter((t) => t !== id) : [...d.tools, id] }))

  const chooseRuntime = (choice: RuntimeChoice): void =>
    setDraft((d) => ({
      ...d,
      backendId: choice.backendId,
      modelId: choice.modelId,
      followsDefault: false,
      ...(choice.thinking ? { thinking: choice.thinking } : { thinking: undefined }),
      ...(choice.fast ? { fast: true } : { fast: undefined })
    }))

  const save = async (): Promise<void> => {
    if (!draft.name.trim() || saving) return
    setSaving(true)
    setTargetStatus(null)
    if (draft.computerTarget.kind === 'vm' && JSON.stringify(draft.computerTarget) !== JSON.stringify(bot?.computerTarget)) {
      const probe = await probeComputerTarget(draft.computerTarget, bot?.id)
      setTargetStatus(probe.detail ?? (probe.ok ? 'VM connection verified.' : 'The VM could not be reached.'))
      if (!probe.ok) {
        setSaving(false)
        return
      }
    }
    /*
     * Only the fields this form owns. `draft` is a copy of the whole bot taken
     * when the editor opened, so posting it back was a full overwrite: it
     * carried `id`/`createdAt`/`updatedAt` and every field the editor does not
     * touch, undoing anything the main process changed meanwhile (a bot pinned
     * or archived from the list while this was open).
     */
    const edited = {
      name: draft.name,
      description: draft.description,
      systemPrompt: draft.systemPrompt,
      // Legacy emoji is display-only. Do not overwrite a value this editor
      // cannot change; a newly created Bot still carries its fallback identity.
      ...(!bot ? { emoji: draft.emoji } : {}),
      color: draft.color,
      ...(draft.avatarShape !== undefined ? { avatarShape: draft.avatarShape, avatarColor: draft.avatarColor } : {}),
      backendId: draft.backendId,
      modelId: draft.modelId,
      followsDefault: draft.followsDefault === false ? false : true,
      thinking: (draft.followsDefault === false && draft.thinking ? draft.thinking : '') as ThinkingDepth,
      ...(draft.fast ? { fast: true } : {}),
      executionAgent: draft.executionAgent,
      // These are no longer editable here. Omitting them on existing Bots
      // preserves live grants and avoids probing an unchanged legacy VM.
      ...(!bot ? {
        tools: draft.tools,
        skills: draft.skills ?? [],
        computerUse: draft.computerUse,
        computerTarget: draft.computerTarget
      } : {})
    }
    const saved = bot ? await updateBot(bot.id, edited) : await createBot(edited)
    setSaving(false)
    if (saved) {
      const abandoned = provisionalTarget.current
      provisionalTarget.current = null
      if (
        abandoned &&
        (saved.computerTarget.kind !== 'vm' || saved.computerTarget.vmId !== abandoned.vmId)
      ) {
        await discardComputerTarget(abandoned)
      }
      onSaved(saved)
    }
  }

  const provision = async (): Promise<VmTarget | null> => {
    const previous = provisionalTarget.current
    const target = await provisionComputerTarget()
    // Keep a working draft alive until its replacement is actually ready. A
    // failed second build must not leave the editor pointing at a box we just
    // destroyed behind its back.
    if (!target) return null
    if (!editorActive.current) {
      await discardComputerTarget(target)
      return null
    }
    provisionalTarget.current = target
    if (previous) await discardComputerTarget(previous)
    return target
  }

  const close = async (): Promise<void> => {
    if (saving) return
    if (confirmDelete) { setConfirmDelete(false); return }
    editorActive.current = false
    await cancelComputerProvision()
    const abandoned = provisionalTarget.current
    provisionalTarget.current = null
    if (abandoned) await discardComputerTarget(abandoned)
    onClose()
  }

  const remove = async (): Promise<void> => {
    if (!bot || saving || !confirmDelete) return
    setSaving(true)
    editorActive.current = false
    await cancelComputerProvision()
    const abandoned = provisionalTarget.current
    provisionalTarget.current = null
    if (abandoned) await discardComputerTarget(abandoned)
    /*
     * Closing is part of deleting. Without it the drawer stayed open on a bot
     * that no longer exists, so `BotEditor` re-rendered with `bot === null` —
     * which is the create form — and the app read as though it were offering to
     * build a replacement the instant you deleted one. A delete that failed has
     * already toasted and leaves the editor where it was.
     */
    const removed = await removeBot(bot.id)
    setSaving(false)
    if (removed) {
      onClose()
      requestAnimationFrame(() => {
        // The deleted Bot's header/card cannot receive return focus. Keep the
        // remaining modal's ownership, or land on persistent navigation.
        if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body && document.activeElement.isConnected) return
        const dialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].at(-1)
        const target = dialog?.querySelector<HTMLElement>('button:not([disabled])')
          ?? document.querySelector<HTMLElement>('.ob-side-item-main, .ob-side-section-head button, .ob-header-left button')
        target?.focus({ preventScroll: true })
      })
    } else editorActive.current = true
  }

  return {
    draft,
    set,
    toggleTool,
    chooseRuntime,
    saving,
    targetStatus,
    confirmDelete,
    setConfirmDelete,
    save,
    provision,
    close,
    remove
  }
}
