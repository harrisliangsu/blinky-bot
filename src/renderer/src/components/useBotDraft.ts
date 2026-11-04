import { useEffect, useRef, useState } from 'react'
import type { ThinkingDepth } from '../../../shared/thinking'
import type { Bot, ComputerTarget } from '../../../shared/types'
import type { RuntimeChoice } from './BotRuntimeFields'
import {
  cancelComputerProvision,
  createBot,
  discardComputerTarget,
  probeComputerTarget,
  provisionComputerTarget,
  removeBot,
  updateBot
} from '../state'
import { EMOJI, SWATCHES } from './BotEditorIdentity'

/** A bot being edited: the saved one, or the fields a new one starts with. */
export type BotDraft = Bot | Omit<Bot, 'id' | 'createdAt' | 'updatedAt'>

type VmTarget = Extract<ComputerTarget, { kind: 'vm' }>

const emptyDraft = (): Omit<Bot, 'id' | 'createdAt' | 'updatedAt'> => ({
  name: '',
  description: '',
  systemPrompt: '',
  emoji: EMOJI[0]!,
  color: SWATCHES[0]!,
  backendId: '',
  modelId: 'default',
  followsDefault: true,
  tools: ['read_file', 'list_dir', 'glob', 'grep', 'request_help'],
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
export function useBotDraft(bot: Bot | null, onClose: () => void, onSaved: (bot: Bot) => void): BotDraftForm {
  const [draft, setDraft] = useState<BotDraft>(() => (bot ? { ...bot } : emptyDraft()))
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
    setDraft(bot ? { ...bot } : emptyDraft())
    setConfirmDelete(false)
    setTargetStatus(null)
  }, [bot?.id])

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
      ...(choice.thinking ? { thinking: choice.thinking } : { thinking: undefined })
    }))

  const save = async (): Promise<void> => {
    if (!draft.name.trim()) return
    setSaving(true)
    setTargetStatus(null)
    if (draft.computerTarget.kind === 'vm') {
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
      emoji: draft.emoji,
      color: draft.color,
      backendId: draft.backendId,
      modelId: draft.modelId,
      followsDefault: draft.followsDefault === false ? false : true,
      thinking: (draft.followsDefault === false && draft.thinking ? draft.thinking : '') as ThinkingDepth,
      tools: draft.tools,
      skills: draft.skills ?? [],
      computerUse: draft.computerUse,
      computerTarget: draft.computerTarget
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
    editorActive.current = false
    await cancelComputerProvision()
    const abandoned = provisionalTarget.current
    provisionalTarget.current = null
    if (abandoned) await discardComputerTarget(abandoned)
    onClose()
  }

  const remove = async (): Promise<void> => {
    editorActive.current = false
    await cancelComputerProvision()
    const abandoned = provisionalTarget.current
    provisionalTarget.current = null
    if (abandoned) await discardComputerTarget(abandoned)
    if (!bot) return
    /*
     * Closing is part of deleting. Without it the drawer stayed open on a bot
     * that no longer exists, so `BotEditor` re-rendered with `bot === null` —
     * which is the create form — and the app read as though it were offering to
     * build a replacement the instant you deleted one. A delete that failed has
     * already toasted and leaves the editor where it was.
     */
    if (await removeBot(bot.id)) onClose()
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
