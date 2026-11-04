import type { ReactNode } from 'react'
import type { BackendInfo, Bot } from '../../../shared/types'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { cancelComputerProvision, computerProvisionStatus } from '../state'
import { BotEditorIdentity } from './BotEditorIdentity'
import { BotEditorModel, BotEditorTools } from './BotEditorTools'
import { BotMemory } from './BotMemory'
import { BotTargetFields } from './BotTargetFields'
import { BotSkills } from './BotSkills'
import { IconClose, IconTrash } from './Icons'
import { targetIncomplete, useBotDraft } from './useBotDraft'
import './BotEditor.css'

interface BotEditorProps {
  /** null creates a new bot. */
  bot: Bot | null
  backends: BackendInfo[]
  backendsLoading: boolean
  backendsError: string | null
  onClose: () => void
  onSaved: (bot: Bot) => void
}

/** Create / edit form for a single bot, plus its memory. */
export function BotEditor({ bot, backends, backendsLoading, backendsError, onClose, onSaved }: BotEditorProps): ReactNode {
  const {
    draft,
    set,
    toggleTool,
    chooseModel,
    saving,
    targetStatus,
    confirmDelete,
    setConfirmDelete,
    save,
    provision,
    close,
    remove
  } = useBotDraft(bot, onClose, onSaved)
  const follow = useSettingsCopy().bots

  return (
    <div className="ob-bot-editor">
      <header className="ob-bot-editor-head">
        <h3>{bot ? 'Edit bot' : 'New bot'}</h3>
        <button type="button" className="ob-icon-btn" onClick={() => void close()} aria-label="Close editor">
          <IconClose />
        </button>
      </header>

      <div className="ob-bot-editor-body">
        <BotEditorIdentity
          emoji={draft.emoji}
          onEmoji={(emoji) => set('emoji', emoji)}
          name={draft.name}
          onName={(name) => set('name', name)}
          color={draft.color}
          onColor={(color) => set('color', color)}
          description={draft.description}
          onDescription={(description) => set('description', description)}
          systemPrompt={draft.systemPrompt}
          onSystemPrompt={(systemPrompt) => set('systemPrompt', systemPrompt)}
        />

        <label className="ob-check">
          <input
            type="checkbox"
            checked={draft.followsDefault !== false}
            onChange={(e) => {
              const followsDefault = e.target.checked
              set('followsDefault', followsDefault)
              if (followsDefault) {
                set('backendId', '')
                set('modelId', 'default')
              }
            }}
          />
          <span>
            {follow.follow}
            <span className="ob-hint"> — {follow.followHint}</span>
          </span>
        </label>

        {draft.followsDefault === false ? (
          <BotEditorModel
            backends={backends}
            backendsLoading={backendsLoading}
            backendsError={backendsError}
            backendId={draft.backendId}
            modelId={draft.modelId}
            onSelect={chooseModel}
          />
        ) : null}

        <BotEditorTools tools={draft.tools} onToggle={toggleTool} />

        <BotSkills
          backendId={draft.backendId}
          selected={draft.skills ?? []}
          onChange={(skills) => set('skills', skills)}
        />

        <label className="ob-check ob-bot-computer">
          <input type="checkbox" checked={draft.computerUse} onChange={(e) => set('computerUse', e.target.checked)} />
          <span>
            Computer use
            <span className="ob-hint"> — lets this bot capture the screen and drive the keyboard and mouse.</span>
          </span>
        </label>

        <BotTargetFields
          key={bot?.id ?? 'new-bot'}
          target={draft.computerTarget}
          onChange={(computerTarget) => set('computerTarget', computerTarget)}
          onProvision={provision}
          onProvisionStatus={computerProvisionStatus}
          onCancelProvision={cancelComputerProvision}
        />
        {targetStatus ? <p className="ob-hint" role="status">{targetStatus}</p> : null}

        {bot ? <BotMemory botId={bot.id} /> : <p className="ob-hint">Memory becomes available once the bot is saved.</p>}
      </div>

      <footer className="ob-bot-editor-foot">
        {bot ? (
          confirmDelete ? (
            <span className="ob-bot-confirm">
              <button type="button" className="ob-btn ob-btn-sm ob-btn-danger" onClick={() => void remove()}>
                Delete for good
              </button>
              <button type="button" className="ob-btn ob-btn-sm" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" className="ob-btn ob-btn-sm ob-btn-ghost" onClick={() => setConfirmDelete(true)}>
              <IconTrash size={12} />
              Delete
            </button>
          )
        ) : (
          <span />
        )}
        <span className="ob-bot-editor-save">
          <button type="button" className="ob-btn ob-btn-sm" onClick={() => void close()}>
            Cancel
          </button>
          <button
            type="button"
            className="ob-btn ob-btn-sm ob-btn-primary"
            onClick={() => void save()}
            disabled={!draft.name.trim() || saving || targetIncomplete(draft.computerTarget)}
          >
            {saving ? 'Saving…' : bot ? 'Save changes' : 'Create bot'}
          </button>
        </span>
      </footer>
    </div>
  )
}
