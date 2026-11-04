/**
 * The gateway's public surface: attach a supervised session, detach it again.
 *
 * `src/main/agent/mcpGateway.ts` loads this module through `import.meta.glob`,
 * which is why the barrel has to exist as a file rather than as a set of named
 * imports — the glob pattern names `../gateway/index.ts` exactly, and with no
 * such file it compiles to an empty map. That is what happened: all eleven
 * modules under `src/main/gateway` were absent from every build, so every
 * agent-CLI session ran without OpenBOT's computer-use, `remember`, `handoff`
 * and routine tools, announced only by a `console.warn` nobody reads.
 *
 * Attaching mints a bearer grant scoped to one bot in one session and starts
 * the loopback HTTP server if it is not already up. Nothing is written to any
 * config file the user owns: the endpoint and token live for the session and
 * are handed to the CLI on its own command line for that turn.
 */

import type { Bot } from '../../shared/types'
import { getBot } from '../store/bots'
import { abortInFlight } from './protocol'
import { closeServer, ensureServer, mcpEndpoint } from './server'
import { closeStreamsFor } from './sse'
import {
  activeGrantCount,
  grantCovers,
  grantsForSession,
  mintGrant,
  revokeToken,
  setGrantMessage
} from './tokens'

export interface GatewayAttachment {
  sessionId: string
  botId: string
  cwd: string
  backendId: string
}

/** Everything a CLI adapter needs to reach the gateway for this turn. */
export interface AttachedGateway {
  name: string
  transport: 'http'
  url: string
  bearerToken: string
}

/** The server name the CLI sees, and the prefix its tools appear under. */
export const GATEWAY_SERVER_NAME = 'openbot'

/**
 * Give this bot an MCP endpoint for the turn about to run.
 *
 * One live grant per bot and session. The grant is where the bot's tool list,
 * working directory and computer-use permission are frozen. When those are
 * unchanged the same token is kept: a warm CLI was started with that token in
 * its environment, and minting a new one would force a cold process. A changed
 * scope revokes the old grant. A different bot in the same session gets its
 * own, because the token is the only thing that says which bot a `tools/call`
 * belongs to.
 */
export async function attachSession(input: GatewayAttachment): Promise<AttachedGateway | null> {
  const bot = getBot(input.botId)
  if (!bot) return null

  // Started before anything is minted: a grant for a listener that failed to
  // come up is a live credential nothing will ever revoke.
  await ensureServer()

  const next = grantInput(bot, input)
  const existing = grantsForSession(input.sessionId).find(
    (grant) => grant.botId === input.botId && grantCovers(grant, next)
  )
  if (existing) {
    return {
      name: GATEWAY_SERVER_NAME,
      transport: 'http',
      url: mcpEndpoint(),
      bearerToken: existing.token
    }
  }

  for (const stale of grantsForSession(input.sessionId)) {
    if (stale.botId === input.botId) revokeToken(stale.token)
  }
  const grant = mintGrant(next)

  return {
    name: GATEWAY_SERVER_NAME,
    transport: 'http',
    url: mcpEndpoint(),
    bearerToken: grant.token
  }
}

/**
 * Point this session's tool events at the assistant message now streaming.
 *
 * Without it a tool the CLI calls through the gateway is invisible: `invoke`
 * only mirrors a call into the transcript when it knows which message owns it,
 * so the user would see the reply mention work that never appeared as a step.
 * The message does not exist yet when the session is attached, which is why
 * this is a second call rather than part of the grant.
 */
export function noteMessage(sessionId: string, messageId: string | undefined): void {
  setGrantMessage(sessionId, messageId)
}

function grantInput(bot: Bot, input: GatewayAttachment): Parameters<typeof mintGrant>[0] {
  return {
    botId: bot.id,
    sessionId: input.sessionId,
    cwd: input.cwd,
    tools: bot.tools ?? [],
    computerUse: bot.computerUse === true,
    computerTarget: bot.computerTarget
  }
}

/**
 * Revoke everything this session holds, and close the listener once nothing is
 * left using it.
 *
 * Revoking aborts each grant's controller, which stops any tool call still
 * running for it; the SSE streams keyed on those tokens go with them.
 */
export async function detachSession(sessionId: string): Promise<void> {
  for (const grant of grantsForSession(sessionId)) {
    abortInFlight(grant)
    closeStreamsFor(grant.token)
    revokeToken(grant.token)
  }
  if (activeGrantCount() === 0) await closeServer()
}
