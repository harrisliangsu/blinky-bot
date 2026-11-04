/**
 * Which backend the default bots should use.
 *
 * OpenCode used to be the hardcoded default. A machine with Codex or Claude
 * Code signed in, and no `opencode` binary, then failed the first message
 * with `spawn opencode ENOENT`. Selection is pure so the startup probe and
 * the tests share one rule.
 */

/** Historical default. Bots created by 0.2.x still carry this id. */
export const FACTORY_DEFAULT_BACKEND_ID = 'opencode'

/**
 * Signed-in CLIs, most common first. pi and Droid stay behind the three the
 * product treats as the primary install path. API-key providers are not in
 * this list; they are the fallback after every CLI.
 */
export const CLI_PICK_ORDER = ['codex', 'claude', 'opencode', 'pi', 'droid'] as const

export interface BackendChoice {
  id: string
  kind: 'agent-cli' | 'cloud-api'
  /** CLI config directory exists, or an API key is stored. */
  signedIn: boolean
  enabled: boolean
}

export interface BotBackendAssignment {
  id: string
  backendId: string
}

const PREFERRED = new Set<string>(CLI_PICK_ORDER)

/** First signed-in, enabled backend. Null when chat has nothing to call. */
export function pickDefaultBackend(choices: readonly BackendChoice[]): string | null {
  const ready = new Set(
    choices.filter((choice) => choice.enabled && choice.signedIn).map((choice) => choice.id)
  )
  for (const id of CLI_PICK_ORDER) {
    if (ready.has(id)) return id
  }
  const otherCli = choices.find(
    (choice) => choice.kind === 'agent-cli' && ready.has(choice.id) && !PREFERRED.has(choice.id)
  )
  if (otherCli) return otherCli.id
  const api = choices.find((choice) => choice.kind === 'cloud-api' && ready.has(choice.id))
  return api?.id ?? null
}

export function retargetPlan(input: {
  defaultBackendId: string
  bots: readonly BotBackendAssignment[]
  readyIds: ReadonlySet<string>
  nextDefault: string | null
}): { defaultBackendId: string; bots: BotBackendAssignment[] } {
  const currentReady = input.readyIds.has(input.defaultBackendId)
  const defaultBackendId = currentReady
    ? input.defaultBackendId
    : (input.nextDefault ?? input.defaultBackendId)
  // Nothing signed in: leave the stored ids alone and let the chat explain.
  if (!input.nextDefault && !currentReady) {
    return { defaultBackendId: input.defaultBackendId, bots: [] }
  }
  const bots = input.bots.flatMap((bot) => {
    if (input.readyIds.has(bot.backendId)) return []
    const followsDefault = bot.backendId === input.defaultBackendId
    // 0.2.x wrote `opencode` onto every starter bot. Move those when that
    // CLI is the one that cannot start, even if Settings was later pointed
    // at something else that is also missing.
    const factoryOpencode =
      bot.backendId === FACTORY_DEFAULT_BACKEND_ID && !input.readyIds.has(FACTORY_DEFAULT_BACKEND_ID)
    if (!followsDefault && !factoryOpencode) return []
    if (bot.backendId === defaultBackendId) return []
    return [{ id: bot.id, backendId: defaultBackendId }]
  })
  return { defaultBackendId, bots }
}
