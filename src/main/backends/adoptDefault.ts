/**
 * Point the default backend, and the bots still following it, at a CLI that
 * is installed and signed in. Runs once at startup, before starter bots are
 * seeded, so a new profile never begins life on a missing `opencode`.
 */

import { DEFAULT_MODEL_ID } from '../settingsSchema'
import { getSettings, updateSettings } from '../settings'
import { listBots, updateBot } from '../store/bots'
import { hasBackendApiKey } from '../store/backendSecrets'
import { DEFAULT_BASE_URLS } from './backendDefaults'
import { AGENT_CLI_SPECS } from './cli'
import { pickDefaultBackend, retargetPlan, type BackendChoice } from './defaultBackend'
import { commandFor } from './cli/spec'
import { anyPathExists, which } from './which'

async function cliChoices(): Promise<BackendChoice[]> {
  const settings = getSettings()
  const choices: BackendChoice[] = []
  for (const spec of AGENT_CLI_SPECS) {
    const config = settings.backends[spec.id] ?? { enabled: true }
    const command = commandFor(spec, config)
    let signedIn = false
    try {
      const binary = command ? await which(command) : null
      if (binary) {
        signedIn = spec.install.paths ? await anyPathExists(spec.install.paths()) : true
        // Grok accepts a saved xAI key when `grok login` has not been run.
        // A key on the Kimi row does not sign that CLI in.
        if (!signedIn && spec.id === 'grok' && (hasBackendApiKey(spec.id) || Boolean(config.apiKey?.trim()))) {
          signedIn = true
        }
      }
    } catch (error) {
      console.warn('[openbot] could not probe', spec.id, error)
    }
    choices.push({
      id: spec.id,
      kind: 'agent-cli',
      signedIn,
      enabled: config.enabled !== false
    })
  }
  return choices
}

function apiChoices(): BackendChoice[] {
  const settings = getSettings()
  return Object.keys(DEFAULT_BASE_URLS).map((id) => ({
    id,
    kind: 'cloud-api' as const,
    signedIn: hasBackendApiKey(id),
    enabled: settings.backends[id]?.enabled !== false
  }))
}

/**
 * Rewrite `defaultBackendId` and any bot still aimed at an unavailable
 * default. Returns the id now in use, or null when nothing is signed in.
 */
export async function adoptReadyDefaultBackend(): Promise<string | null> {
  const settings = getSettings()
  const choices = [...(await cliChoices()), ...apiChoices()]
  const readyIds = new Set(choices.filter((choice) => choice.enabled && choice.signedIn).map((choice) => choice.id))
  const nextDefault = pickDefaultBackend(choices)
  const plan = retargetPlan({
    defaultBackendId: settings.defaultBackendId,
    bots: listBots().map((bot) => ({ id: bot.id, backendId: bot.backendId })),
    readyIds,
    nextDefault
  })
  if (plan.defaultBackendId !== settings.defaultBackendId) {
    updateSettings({ defaultBackendId: plan.defaultBackendId, defaultModelId: DEFAULT_MODEL_ID })
    console.info(
      '[openbot] default backend',
      settings.defaultBackendId,
      '→',
      plan.defaultBackendId
    )
  }
  for (const change of plan.bots) {
    updateBot(change.id, { backendId: change.backendId, modelId: DEFAULT_MODEL_ID })
  }
  return readyIds.has(plan.defaultBackendId) ? plan.defaultBackendId : null
}
