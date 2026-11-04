import type { ReactNode } from 'react'
import type { ToolId } from '../../../shared/types'

/**
 * The groups follow the sections `TOOL_IDS` itself is written in. Typed as
 * `ToolId`, so a renamed or mistyped id fails the build here rather than
 * rendering a checkbox that grants a tool no registry can run.
 */
const TOOL_GROUPS: Array<{ label: string; ids: ToolId[] }> = [
  { label: 'Files & code', ids: ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'shell'] },
  { label: 'Web', ids: ['fetch', 'web_search'] },
  { label: 'Computer', ids: ['screenshot', 'click', 'type_text', 'key_press', 'scroll', 'drag', 'open_app', 'navigate'] },
  /*
   * `visualize` was in `TOOL_IDS` and in the registry but in no group, and
   * `schemasFor` only advertises a tool the bot has been granted — so it could
   * never be granted from here, and a bot that somehow carried it showed no
   * trace of it either, because the hint below only named ids from outside the
   * contract. It draws a chart in the transcript and reads, writes and runs
   * nothing, so it belongs beside the other presentation-only work.
   */
  { label: 'Presentation', ids: ['visualize'] },
  { label: 'Bot', ids: ['todo_write', 'remember', 'handoff', 'delegate_task', 'request_help'] }
]

/*
 * Measured against what the groups actually render, not against `TOOL_IDS`: an
 * id the contract has but no group lists is exactly how `visualize` went
 * invisible, so the hint now names it instead of hiding it.
 */
const GROUPED_IDS: ReadonlySet<string> = new Set(TOOL_GROUPS.flatMap((group) => group.ids))

interface ToolsProps {
  tools: string[]
  onToggle: (id: string) => void
}

/** The tool grant, grouped the way the tools themselves are. */
export function BotEditorTools({ tools, onToggle }: ToolsProps): ReactNode {
  const ungroupedTools = tools.filter((id) => !GROUPED_IDS.has(id))

  return (
    <div className="ob-field">
      <span className="ob-label">Tools</span>
      {TOOL_GROUPS.map((group) => (
        <fieldset key={group.label} className="ob-bot-tools">
          <legend>{group.label}</legend>
          {group.ids.map((id) => (
            <label key={id} className="ob-check">
              <input type="checkbox" checked={tools.includes(id)} onChange={() => onToggle(id)} />
              <span>{id}</span>
            </label>
          ))}
        </fieldset>
      ))}
      {ungroupedTools.length > 0 ? <p className="ob-hint">Also enabled: {ungroupedTools.join(', ')}</p> : null}
    </div>
  )
}
