/**
 * GitHub, Gmail, and X are shared by every Bot once the account is saved.
 * Per-Bot allowlists no longer decide this. VM targets still cannot call host
 * connectors: the tool registry refuses those names for a VM computer target.
 */

import { liveBotTools } from '../agent/botToolScope'
import { listGoogleAccounts } from '../connectors/googleSecrets'
import { readGitHubCredentials } from '../connectors/githubSecrets'
import { readXCredentials } from '../connectors/xSecrets'
import { CONNECTED_APP_TOOLS } from '../../shared/connectedAppTools'

export async function sharedConnectedAppTools(): Promise<string[]> {
  const tools: string[] = []
  try { if (await readGitHubCredentials()) tools.push(...CONNECTED_APP_TOOLS.github) } catch { /* no saved GitHub connection */ }
  try { if ((await listGoogleAccounts('gmail')).length > 0) tools.push(...CONNECTED_APP_TOOLS.gmail) } catch { /* no saved Gmail connection */ }
  try { if (await readXCredentials()) tools.push(...CONNECTED_APP_TOOLS.x) } catch { /* no saved X connection */ }
  return tools
}

export async function toolsVisibleToBot(bot: { id: string; tools?: readonly string[]; computerTarget?: { kind?: string } }): Promise<string[]> {
  const own = liveBotTools(bot.id, bot.tools ?? [])
  if (bot.computerTarget?.kind === 'vm') return own
  return [...new Set([...own, ...await sharedConnectedAppTools()])]
}
