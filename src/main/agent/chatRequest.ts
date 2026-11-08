/**
 * Assembles the `ChatRequest` for one turn.
 *
 * Most of this is plumbing an agent CLI needs and a plain model API ignores. Each field
 * is here because leaving it out failed silently rather than loudly — see the comments.
 */

import type { Bot, Session, Settings } from '../../shared/types'
import type { ChatRequest, ProviderMessage } from './contracts'
import type { RuntimeMcpServer } from './turnTypes'
import type { TurnMode } from './backendMode'
import { conversationKey } from './conversationKey'
import { isReadOnlyMode } from './modes'
import { requestApproval } from './approval'
import { analyzeCommand } from '../tools/shell/classify'
import { mcpBearerToken } from '../store/mcpSecrets'
import { isCodexCoordinator, isTracedBackgroundRun } from './executionAgent'
import { usesApplicationToolLoop } from '../../shared/executionAgentCapabilities'
import { requestTaskClarification } from '../tasks/clarifications'
import { localExecutionPolicy } from '../../shared/localExecution'
import { taskJudgmentScope } from './taskJudgmentScope'

export interface ChatRequestInput {
  session: Session
  bot: Bot
  settings: Settings
  signal: AbortSignal
  mode: TurnMode
  messages: ProviderMessage[]
  /** Capability already resolved for this turn's selected model. */
  supportsVision?: boolean
  tools: ChatRequest['tools']
  /** OpenBOT's own MCP endpoint for this bot and session, when one is attached. */
  gateway?: RuntimeMcpServer
}

/**
 * MCP servers this turn's CLI should be given: the user's own, plus OpenBOT's
 * gateway when one was attached for this bot.
 */
function mcpServersFor(input: ChatRequestInput): ChatRequest['mcpServers'] {
  // Third-party MCP servers execute outside the CLI sandbox and cannot be
  // classified as read-only. Ask/Plan must not expose them directly.
  const configured = (taskJudgmentScope(input.session.id) || isReadOnlyMode(input.session.mode) || isCodexCoordinator(input.session, input.bot) || usesApplicationToolLoop(input.bot.backendId) ? [] : (input.settings.mcpServers ?? []))
    .filter((server) => server.enabled)
    .map((server) => ({
      name: server.accountName?.trim() ? `${server.name} ${server.accountName.trim()}` : server.name,
      transport: server.transport,
      ...(server.command ? { command: server.command } : {}),
      ...(server.args ? { args: server.args } : {}),
      ...(server.url ? { url: server.url } : {}),
      ...(server.env ? { env: server.env } : {}),
      ...(server.auth ? { auth: server.auth } : {}),
      ...(server.auth === 'bearer' && mcpBearerToken(server.id) ? { bearerToken: mcpBearerToken(server.id) } : {})
    }))

  return input.gateway ? [...configured, { ...input.gateway }] : configured
}

/**
 * The only CLI-raised permission kinds Ask and Plan still allow.
 *
 * `mcp` is refused with the mutators rather than trusted: OpenBOT's own gateway
 * tools are already mode-filtered before they get here, so an `mcp` request
 * reaching this callback belongs to a server the user configured, whose tools
 * we cannot classify. A mode that promises nothing is modified has to treat an
 * unknown tool as one that might.
 */
const READ_ONLY_KINDS = new Set(['fetch'])

export function buildChatRequest(input: ChatRequestInput): ChatRequest {
  const { session, bot, settings, signal, mode, messages, tools } = input
  return {
    model: bot.modelId,
    localExecutionSessionId: session.id,
    requestInput: questions => taskJudgmentScope(session.id) ? Promise.reject(new Error('Return the required action as a task decision; do not open a new question from internal consideration.')) : requestTaskClarification(session.id, bot.id, questions, signal),
    captureAgentTrace: isTracedBackgroundRun(session.id),
    ...(input.supportsVision === undefined ? {} : { supportsVision: input.supportsVision }),
    ...(bot.thinking ? { thinking: bot.thinking } : {}),
    messages,
    // pi and model APIs use this application-owned tool loop; other CLIs use MCP.
    tools: mode === 'orchestrated' && tools?.length ? tools : undefined,
    // A VM-compatible CLI may still run as a model client on the host, but it
    // must not expose even read-only host tools. OpenBOT owns the loop and
    // routes every supplied tool through the authenticated VM daemon instead.
    disableNativeTools: bot.computerTarget?.kind === 'vm' || usesApplicationToolLoop(bot.backendId),
    restrictNativeWrites: isReadOnlyMode(session.mode) || isCodexCoordinator(session, bot),
    coordinatorOnly: isCodexCoordinator(session, bot),
    /*
     * `readOnly` is deliberately NOT set from the session mode.
     *
     * It means "background side call: produce text and nothing else", and the
     * adapters implement exactly that — claude `--tools ''`, pi `--no-tools`,
     * opencode `permission: 'deny'`. Setting it for Ask and Plan took the read
     * tools away too, so a mode whose whole purpose is to look without touching
     * could not look either: the model was told it may read files and search,
     * and every one of those calls was refused.
     *
     * Ask and Plan are enforced by the gateway and by the CLI's own
     * restrictions where the transport supports them; the approval callback
     * alone cannot prevent an action a CLI chooses not to ask about.
     */
    signal,
    // The folder the user chose for this chat. Without it an agent CLI
    // inherits wherever Electron was launched from and works in the wrong
    // place — silently, since it still succeeds.
    cwd: session.cwd,
    // A CLI that governs its own tools is held to the user's policy rather
    // than falling back to its own, more permissive, default.
    approvalPolicy: localExecutionPolicy(settings) === 'always-allow' && settings.automaticReview !== false ? 'auto-run' : 'ask-every-time',
    // Servers the user configured in Settings, plus OpenBOT's own gateway —
    // the only route our tools have into a CLI that runs its own tool loop.
    mcpServers: mcpServersFor(input),
    // Lets a session-based CLI continue its own conversation between turns
    // instead of starting cold each time, without two bots sharing one thread.
    sessionKey: conversationKey(taskJudgmentScope(session.id)?.nativeSessionId?{...session,id:taskJudgmentScope(session.id)!.nativeSessionId!}:session, bot),
    /*
     * Permission requests raised by a session-based CLI are answered by the
     * same gate, policy and allowlist as our own tools — rather than the CLI
     * quietly answering them itself, which is what one-shot `exec` does.
     */
    approve: async ({ kind, summary, detail, target, force }) => {
      const judgment=taskJudgmentScope(session.id)
      if(judgment){judgment.attemptedTool=true;return 'reject'}
      const policyTarget = target?.trim() || detail
      /*
       * An approval dialog must not be offered for something the mode
       * forbids. Adapters must also enforce their own native-tool restrictions.
       */
      if (isReadOnlyMode(session.mode) && !READ_ONLY_KINDS.has(kind)) return 'reject'
      if (isCodexCoordinator(session, bot) && ['shell', 'write', 'edit', 'computer'].includes(kind)) return 'reject'
      let mustConfirm = force === true
      if (kind === 'shell') {
        const analysis = analyzeCommand(policyTarget, settings.denylist)
        // CLI-owned shell tools must obey the same hard refusal as OpenBOT's
        // own shell tool; an approval dialog is not an escape hatch for it.
        if (analysis.blocked) return 'reject'
        mustConfirm ||= analysis.risk === 'high'
      }
      const outcome = await requestApproval({
        sessionId: session.id,
        toolName: kind === 'shell' ? 'shell' : bot.backendId,
        target: policyTarget,
        kind,
        summary,
        detail,
        force: mustConfirm,
        nativeExplicit: force === true,
        localExecution: true,
        signal
      })
      if (!outcome.approved) return 'reject'
      return outcome.decision === 'approve-always' ? 'approve-always' : 'approve'
    }
  }
}
