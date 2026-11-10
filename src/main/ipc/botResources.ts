/** User-opened resources; never changes execution targets or screen permissions. */
import { app, shell } from 'electron'
import { stat } from 'node:fs/promises'
import { getBot } from '../store/bots'
import { getSession } from '../store/sessions'
import { dataRoot } from '../store/paths'
import { getComputerProvider } from '../tools/computer'
import { EgoComputerProvider } from '../tools/computer/browser/egoProvider'
import { handle } from './handler'
import { asId } from './validate'

export type BotResourceResult = { ok: true; spaceId?: number } | { ok: false; error: string }

export async function openBotResource(botId: string, sessionId: string, kind: unknown): Promise<BotResourceResult> {
  const bot = getBot(botId), session = getSession(sessionId)
  if (!bot || bot.archived || !session || session.archived || !session.botIds.includes(botId)) throw new Error('The Bot or its conversation is unavailable.')
  if (kind === 'computer') {
    const directory = session.cwd || app.getPath('home')
    if (!(await stat(directory)).isDirectory()) throw new Error('The working folder is unavailable.')
    const error = await shell.openPath(directory)
    if (error) throw new Error('The working folder could not be opened.')
    return { ok: true }
  }
  if (kind !== 'browser') throw new Error('Unknown Bot resource.')
  const provider = getComputerProvider({ kind: 'browser', botId, provider: 'ego' }, { botId, sessionId, dataDir: dataRoot() })
  if (!(provider instanceof EgoComputerProvider)) throw new Error('The Ego browser is unavailable.')
  return { ok: true, spaceId: await provider.openForUser() }
}

export function registerBotResourcesIpc(): void {
  handle<BotResourceResult>('openbot:bots:openResource', ([botId, sessionId, kind]) => openBotResource(asId(botId), asId(sessionId), kind),
    (_args, error) => ({ ok: false, error: error instanceof Error ? error.message : 'Could not open this resource.' }))
}
