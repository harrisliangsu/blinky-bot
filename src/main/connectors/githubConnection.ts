/** App-local opt-out. Never logs the user out of their shared GitHub CLI. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonNow } from '../store/jsonStore'
import { dataRoot } from '../store/paths'

let queue: Promise<unknown> = Promise.resolve()
const file = (): string => join(dataRoot(), 'github-connection.json')
async function readPreference(): Promise<boolean> {
  let raw: string
  try { raw = await readFile(file(), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true // Existing CLI connections stay compatible.
    throw new Error('GitHub connection preferences could not be read.')
  }
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('GitHub connection preferences are damaged; they were not changed.') }
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1 || typeof (value as { enabled?: unknown }).enabled !== 'boolean') throw new Error('GitHub connection preferences are invalid; they were not changed.')
  return (value as { enabled: boolean }).enabled
}
export async function githubEnabled(): Promise<boolean> { await queue; return readPreference() }
export function setGitHubEnabled(enabled: boolean): Promise<void> {
  const operation = queue.then(async () => { await readPreference(); await writeJsonNow(file(), { version: 1, enabled }) })
  queue = operation.catch(() => undefined)
  return operation
}
export async function requireGitHubConnection(): Promise<void> {
  if (!await githubEnabled()) throw new Error('GitHub is disconnected in BlinkyBot. Reconnect it in Apps.')
}
