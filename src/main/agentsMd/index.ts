/**
 * AGENTS.md files BlinkyBot can list, create, and edit.
 *
 * Discovered files are the ones already on disk in agent homes. Managed files
 * live under the app data directory. Nothing here revokes a CLI's own read of
 * a workspace AGENTS.md.
 */

import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  AGENTS_MD_NAME,
  agentsMdSummary,
  candidateAgentsMdPaths,
  type AgentsMdBody,
  type AgentsMdRecord
} from '../../shared/agentsMd'
import { dataRoot } from '../store/paths'

interface StoredFile { id: string; title: string; path: string }

function rootDir(): string { return join(dataRoot(), 'agents-md') }
function indexPath(): string { return join(rootDir(), 'index.json') }
function managedPath(id: string): string { return resolve(rootDir(), 'files', id, AGENTS_MD_NAME) }

async function readIndex(): Promise<StoredFile[]> {
  try {
    const raw = JSON.parse(await readFile(indexPath(), 'utf8')) as { files?: unknown }
    if (!Array.isArray(raw.files)) return []
    return raw.files.filter((item): item is StoredFile => !!item && typeof item === 'object'
      && typeof (item as StoredFile).id === 'string'
      && typeof (item as StoredFile).title === 'string'
      && typeof (item as StoredFile).path === 'string')
  } catch {
    return []
  }
}

async function writeIndex(files: StoredFile[]): Promise<void> {
  await mkdir(rootDir(), { recursive: true })
  await writeFile(indexPath(), JSON.stringify({ version: 1, files }, null, 2), { mode: 0o600 })
}

async function isRegularFile(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile() } catch { return false }
}

function discoveredId(path: string): string {
  return `disc-${createHash('sha256').update(path).digest('hex').slice(0, 24)}`
}

async function summaryOf(path: string): Promise<string> {
  try {
    const text = await readFile(path, 'utf8')
    return agentsMdSummary(text.slice(0, 4000))
  } catch {
    return ''
  }
}

export async function listAgentsMd(): Promise<AgentsMdRecord[]> {
  const stored = await readIndex()
  const records: AgentsMdRecord[] = []
  for (const file of stored) {
    const expected = managedPath(file.id)
    if (resolve(file.path) !== expected) continue
    records.push({
      id: file.id,
      title: file.title || AGENTS_MD_NAME,
      path: expected,
      summary: await isRegularFile(expected) ? await summaryOf(expected) : '',
      managed: true
    })
  }
  const seen = new Set(records.map((item) => item.path))
  for (const path of candidateAgentsMdPaths(homedir(), process.env)) {
    if (seen.has(path) || !(await isRegularFile(path))) continue
    records.push({
      id: discoveredId(path),
      title: AGENTS_MD_NAME,
      path,
      summary: await summaryOf(path),
      managed: false
    })
  }
  return records
}

export async function readAgentsMd(id: string): Promise<string> {
  const file = (await listAgentsMd()).find((item) => item.id === id)
  if (!file) throw new Error('AGENTS.md was not found.')
  const text = await readFile(file.path, 'utf8')
  return text.slice(0, 64 * 1024)
}

export async function readAgentsMdBodies(ids: readonly string[]): Promise<AgentsMdBody[]> {
  const wanted = new Set(ids)
  const files = (await listAgentsMd()).filter((item) => wanted.has(item.id))
  const bodies: AgentsMdBody[] = []
  for (const file of files) {
    try {
      bodies.push({ title: file.title, path: file.path, body: (await readFile(file.path, 'utf8')).slice(0, 64 * 1024) })
    } catch { /* A missing file drops out of the prompt rather than failing the turn. */ }
  }
  return bodies
}

export async function createAgentsMd(title = AGENTS_MD_NAME): Promise<AgentsMdRecord> {
  const id = `managed-${randomUUID()}`
  const path = managedPath(id)
  await mkdir(join(path, '..'), { recursive: true })
  const heading = title.trim() || AGENTS_MD_NAME
  await writeFile(path, `# ${heading}\n`, { mode: 0o600 })
  const stored = await readIndex()
  stored.push({ id, title: heading, path })
  await writeIndex(stored)
  return { id, title: heading, path, summary: `# ${heading}`, managed: true }
}

export async function writeAgentsMd(id: string, content: string): Promise<void> {
  const file = (await listAgentsMd()).find((item) => item.id === id)
  if (!file) throw new Error('AGENTS.md was not found.')
  if (file.managed && resolve(file.path) !== managedPath(file.id)) throw new Error('Refusing to write outside the managed AGENTS.md directory.')
  if (!file.managed && basename(file.path) !== AGENTS_MD_NAME) throw new Error('Only an AGENTS.md file can be edited.')
  if (!(await isRegularFile(file.path))) throw new Error('AGENTS.md is not a regular file.')
  await writeFile(file.path, content.slice(0, 64 * 1024), { mode: 0o600 })
}
