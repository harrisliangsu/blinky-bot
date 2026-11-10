import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { ApprovalDecision, ApprovalRequest } from '../../../shared/types'
import { diffFromText } from '../lib/diff'
import { pngSrc } from '../lib/format'
import { resolveSettingsLang } from '../lib/settingsCopy'
import { useAppState } from '../state'
import { BotAvatar } from './BotAvatar'
import { DiffView } from './DiffView'
import { IconCheck, IconChat, IconClose, IconWarning } from './Icons'
import './ApprovalDialog.css'

interface ApprovalDialogProps {
  request: ApprovalRequest
  onDecide: (decision: ApprovalDecision) => void
  /** How many further requests are waiting behind this one. */
  queued: number
}

const KIND_LABEL: Record<ApprovalRequest['kind'], [string, string]> = {
  shell: ['执行命令', 'Run a command'],
  write: ['写入文件', 'Write a file'],
  edit: ['修改文件', 'Edit a file'],
  delete: ['删除', 'Delete'],
  fetch: ['网络请求', 'Network request'],
  mcp: ['MCP 工具', 'MCP tool'],
  computer: ['控制电脑', 'Control the computer']
}

// These operations use the generic mutating-action approval policy, but they
// do not write a file. Name the requested action rather than its policy bucket.
const TOOL_LABEL: Record<string, [string, string]> = {
  delegate_task: ['派发任务', 'Delegate a task'],
  manage_task: ['恢复任务', 'Resume a task'],
  handoff: ['交接任务', 'Hand off a task'],
  todo_write: ['更新待办', 'Update the task list'],
  remember: ['保存记忆', 'Save a memory'],
  request_help: ['请求协助', 'Request help']
}

/**
 * How long a freshly shown request ignores input.
 *
 * Answering one request pops the next into the same place under the pointer, so
 * the second half of a double-click — or a held key — would decide an action the
 * user has not read. Nothing a human can read and answer lands this fast.
 */
const ARM_MS = 400

/** Blocking gate for a mutating action. Esc rejects, handled by the app shell. */
export function ApprovalDialog({ request, onDecide, queued }: ApprovalDialogProps): ReactNode {
  const { bots, currentSessionId, session, sessions, settings } = useAppState()
  const zh = resolveSettingsLang(settings?.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'
  // Stamped at first render, not in the effect, so the window is armed before
  // anything can be clicked rather than one paint later.
  const shownAt = useRef(Date.now())
  const diff = useMemo(() => diffFromText(request.detail), [request.detail])

  /*
   * Which chat, and which bot, is asking.
   *
   * The queue takes requests from ANY session (see state/events.ts) — that is
   * deliberate, because a background task or a group broadcast must still be
   * able to reach the user. But the card named neither, so reading chat A and
   * being handed a `shell` gate raised by chat B looked exactly like a gate
   * raised by what was on screen, and was approved on that belief.
   *
   * The title is read the way PaneChat reads it: the live session when it is
   * the one asking, the sidebar summary otherwise. The bot is only named when
   * it is not a guess — a foreign session with several bots in it gives no way
   * to tell which one raised this, and a confident wrong name on a security
   * prompt is worse than no name.
   */
  const origin = useMemo(() => {
    const live = session?.id === request.sessionId ? session : null
    const summary = sessions.find((s) => s.id === request.sessionId)
    const botIds = live?.botIds ?? summary?.botIds ?? []
    const botId = live?.activeBotId ?? (botIds.length === 1 ? botIds[0] : undefined)
    return {
      title: botIds.length === 1 && request.sessionId === currentSessionId
        ? ''
        : live?.title || summary?.title || (zh ? '未命名对话' : 'Untitled chat'),
      bot: botId ? bots.find((b) => b.id === botId) : undefined,
      /* The case the user cannot otherwise see: this is not the chat on screen. */
      elsewhere: request.sessionId !== currentSessionId
    }
  }, [bots, currentSessionId, request.sessionId, session, sessions, zh])

  /*
   * A forced request can never be satisfied by a stored rule.
   *
   * `approvalPolicy.evaluate` short-circuits `force` to "ask" ABOVE the
   * allowlist check, so the pattern "Always approve" persists is unreachable
   * for this request forever. Offering the button anyway was worse than a
   * no-op: `derivePattern` widens the allowlist for every OTHER call that
   * matches — `rm *` from one `rm -rf` — while this action goes on prompting
   * every time. The user paid a standing permission and got nothing.
   *
   * Screen control keeps its own reason for hiding the button: there is no
   * honest pattern for "this click", so the main process refuses to persist one.
   */
  const forced = request.force === true
  const canRemember = !forced && request.kind !== 'computer'

  useEffect(() => {
    shownAt.current = Date.now()
  }, [request.id])

  const decide = (decision: ApprovalDecision): void => {
    if (Date.now() - shownAt.current < ARM_MS) return
    onDecide(decision)
  }

  return (
    <div className="ob-approval-inline">
      <div
        className={`ob-approval${forced ? ' is-forced' : ''}`}
        role="group"
        aria-live="polite"
        aria-labelledby="ob-approval-title"
        aria-describedby="ob-approval-origin"
        onKeyDown={(event) => { if (event.key === 'Escape') event.stopPropagation() }}
      >
        <header className="ob-approval-head">
          <div className="ob-approval-head-row">
            <span className={`ob-pill ${forced ? 'ob-pill-bad' : 'ob-pill-warn'}`}>
              <IconWarning size={11} />
              {(TOOL_LABEL[request.toolName] ?? KIND_LABEL[request.kind])[zh ? 0 : 1]}
            </span>
            <span className="ob-approval-tool">{request.toolName}</span>
            {/* `force` means approval cannot be remembered; it does not by itself
                establish that the action is irreversible. */}
            {forced ? <span className="ob-pill ob-pill-bad">{zh ? '每次确认' : 'Confirmation required'}</span> : null}
            {queued > 0 ? <span className="ob-pill">{zh ? `另有 ${queued} 项等待确认` : `${queued} more waiting`}</span> : null}
          </div>

          {/*
            Who is asking. `aria-describedby` points here, so a screen reader
            announces the chat and the bot with the dialog rather than leaving
            the origin to be discovered by tabbing.
          */}
          <p id="ob-approval-origin" className="ob-approval-origin">
            {origin.bot ? <BotAvatar bot={origin.bot} size="sm" /> : <IconChat size={12} />}
            <span>
              {origin.bot ? origin.bot.name : (zh ? '来自' : 'Asked')}
              {origin.title ? <span className="ob-approval-origin-title">{zh ? ' · ' : ' in '}{origin.title}</span> : null}
            </span>
            {origin.elsewhere ? <span className="ob-pill ob-pill-accent">{zh ? '其他对话' : 'Another chat'}</span> : null}
          </p>
        </header>

        <h2 id="ob-approval-title" className="ob-approval-summary">
          {request.summary}
        </h2>

        {/*
          Focusable, and the only scroll container in the card.
          A keyboard-only user could read the first screenful of a 200-line
          script and no further: nothing inside was focusable, the panel that
          holds focus is not the element that scrolls, and the code block added a
          second scroller of its own with no way in. They were being asked to
          approve what they could not finish reading. `tabIndex` puts this region
          in the trap's cycle, before the buttons, so Tab lands here first and
          the arrow keys scroll it.
        */}
        <div
          className="ob-approval-detail"
          tabIndex={0}
          role="group"
          aria-label={zh ? `${request.toolName} 请求的操作详情` : `What ${request.toolName} is asking to do`}
        >
          {diff ? (
            <DiffView lines={diff} path={request.summary} />
          ) : request.detail ? (
            <pre className="ob-approval-code">{request.detail}</pre>
          ) : (
            <p className="ob-hint">{zh ? '此操作没有提供更多详情。' : 'No further detail was provided for this action.'}</p>
          )}

          {request.preview ? (
            <img className="ob-approval-preview" src={pngSrc(request.preview)} alt={zh ? '将受此操作影响的屏幕预览' : 'Preview of the screen this action will affect'} />
          ) : null}
        </div>

        <footer className="ob-approval-foot">
          <p className="ob-approval-note">
            {forced
              ? (zh ? '此操作每次都需确认。' : 'This action always requires confirmation.')
              : (zh ? '确认前不会执行。' : 'Nothing runs until you decide.')}
          </p>
          <div className="ob-approval-buttons">
            <button type="button" className="ob-btn ob-btn-danger" onClick={() => decide('reject')}>
              <IconClose size={12} />
              {zh ? '拒绝' : 'Reject'}
            </button>
            {/* Hidden for a forced request, and for screen control — see `canRemember`. */}
            {canRemember ? (
              <button type="button" className="ob-btn" onClick={() => decide('approve-always')}>
                {zh ? '始终允许' : 'Always approve'}
              </button>
            ) : null}
            <button type="button" className="ob-btn ob-btn-primary" onClick={() => decide('approve')}>
              <IconCheck size={12} />
              {zh ? '允许' : 'Approve'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
