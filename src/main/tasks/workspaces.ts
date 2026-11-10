/** Application-owned working directories. This is ownership, not an OS sandbox. */
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { AgentTask } from '../../shared/types'
import type { TaskWorkspace } from '../../shared/taskPlan'
import { dataRoot } from '../store/paths'
import { writeJsonNow } from '../store/jsonStore'

const exec = promisify(execFile)
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const locks = new Map<string, Promise<void>>()
interface Manifest { version: 1; taskId: string; ownerBotId: string; sessionId: string; state: 'preparing' | 'ready' | 'failed'; workspace: TaskWorkspace; error?: string }
async function serial<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const pending = new Promise<void>(done => { release = done }), next = previous.then(() => pending)
  locks.set(key, next); await previous
  try { return await action() } finally { release(); if (locks.get(key) === next) locks.delete(key) }
}
async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec('/usr/bin/git', ['-C', cwd, ...args], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } })
  return result.stdout
}
function applyPatch(cwd: string, patch: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn('/usr/bin/git', ['-C', cwd, 'apply', '--binary', '--whitespace=nowarn', '-'], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    const timer = setTimeout(() => child.kill('SIGTERM'), 30_000)
    child.once('error', fail); child.once('close', code => { clearTimeout(timer); code === 0 ? done() : fail(new Error('Tracked changes could not be applied; the new worktree is retained for inspection.')) })
    child.stdin.on('error', () => {}); child.stdin.end(patch)
  })
}
const owner = (task: AgentTask): string => task.requesterBotId ?? task.botId
const contained = (root: string, path: string): boolean => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part) }

export function parseSavedTaskWorkspace(value: unknown): TaskWorkspace | undefined {
  if (value === undefined) return undefined
  const item = value as TaskWorkspace
  if (!item || typeof item !== 'object' || !['git-worktree', 'directory', 'shared', 'legacy'].includes(item.strategy) || !isAbsolute(item.path ?? '') || !isAbsolute(item.sourceCwd ?? '') || !isAbsolute(item.manifest ?? '') || !Number.isFinite(item.createdAt)) throw new TypeError('The saved task workspace is invalid.')
  if (item.strategy === 'git-worktree' && (typeof item.branch !== 'string' || !/^blinky\/task-[a-f0-9]{24}$/.test(item.branch) || !isAbsolute(item.repoRoot ?? ''))) throw new TypeError('The saved worktree metadata is invalid.')
  if (item.baseline && (!/^[a-f0-9]{40,64}$/.test(item.baseline.head ?? '') || !/^[a-f0-9]{64}$/.test(item.baseline.trackedPatchSha256 ?? '') || !Number.isSafeInteger(item.baseline.untrackedCount) || item.baseline.untrackedCount < 0)) throw new TypeError('The saved workspace baseline is invalid.')
  return { strategy: item.strategy, path: item.path, sourceCwd: item.sourceCwd, manifest: item.manifest, createdAt: item.createdAt, ...(item.repoRoot ? { repoRoot: item.repoRoot } : {}), ...(item.branch ? { branch: item.branch } : {}), ...(item.basedOnTaskId ? { basedOnTaskId: item.basedOnTaskId } : {}), ...(item.baseline ? { baseline: item.baseline } : {}) }
}

/** Predict shared writers before allocating an execution slot. */
export function taskWorkspaceKey(task: AgentTask, tasks: AgentTask[], sessionCwd?: string): string {
  if (task.workspace) return 'path:' + resolve(task.workspace.path)
  if (!task.plan) return 'path:' + resolve(sessionCwd ?? task.sessionId)
  if (task.plan.workspace === 'shared') return 'path:' + resolve(task.plan.sourceCwd)
  if (task.plan.workspace === 'auto' && task.plan.dependencies.length === 1) {
    const dependency = tasks.find(value => value.id === task.plan!.dependencies[0])
    if (dependency?.workspace) return 'path:' + resolve(dependency.workspace.path)
  }
  return 'task:' + task.id
}

export async function prepareTaskWorkspace(task: AgentTask, tasks: AgentTask[], sessionCwd: string, allowed: () => boolean): Promise<TaskWorkspace> {
  const check = (): void => { if (!allowed()) throw new Error('Workspace preparation was cancelled. Existing and newly created files are retained.') }
  check()
  if (task.planInvalid) throw new Error('The saved task plan needs inspection before execution.')
  if (task.workspace) {
    const item = parseSavedTaskWorkspace(task.workspace)!
    const manifest = JSON.parse(await readFile(item.manifest, 'utf8')) as Manifest
    if (manifest.version !== 1 || manifest.state !== 'ready' || manifest.ownerBotId !== owner(task) || manifest.sessionId !== task.sessionId || manifest.workspace.path !== item.path) throw new Error('The retained workspace does not match this task and execution session.')
    await realpath(item.path); check(); return item
  }
  const source = await realpath(task.plan?.sourceCwd ?? sessionCwd)
  if (!(await lstat(source)).isDirectory()) throw new Error('The source workspace is unavailable.')
  const parent = join(dataRoot(), 'workspaces', 'bots', hash(owner(task)).slice(0, 24), 'tasks', hash(task.id).slice(0, 24))
  await mkdir(parent, { recursive: true, mode: 0o700 }); check()
  const manifestPath = join(parent, 'workspace.json')
  // Re-enter only an explicitly saved assignment. A partial create is never
  // silently replaced, retried or removed after a crash.
  try { await lstat(manifestPath); throw new Error('A previous workspace preparation exists; inspect it before retrying.') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  let basedOn: AgentTask | undefined
  if (task.plan?.workspace === 'auto' && task.plan.dependencies.length === 1) basedOn = tasks.find(value => value.id === task.plan!.dependencies[0] && value.status === 'completed' && owner(value) === owner(task))
  const shared = !task.plan || task.plan.workspace === 'shared' || !!basedOn?.workspace
  let workspace: TaskWorkspace = { strategy: !task.plan ? 'legacy' : shared ? 'shared' : 'directory', path: basedOn?.workspace?.path ?? (shared ? source : join(parent, 'files')), sourceCwd: source, manifest: manifestPath, createdAt: Date.now(), ...(basedOn ? { basedOnTaskId: basedOn.id } : {}) }
  let manifest: Manifest = { version: 1, taskId: task.id, ownerBotId: owner(task), sessionId: task.sessionId, state: 'preparing', workspace }
  await writeJsonNow(manifestPath, manifest); check()
  try {
    if (!shared) {
      let repoRoot: string | undefined
      try { repoRoot = (await git(source, ['rev-parse', '--show-toplevel'])).trim(); if (!repoRoot) repoRoot = undefined }
      catch (error) {
        if (!(error && typeof error === 'object' && 'stderr' in error && String(error.stderr).includes('not a git repository'))) throw error
      }
      if (repoRoot) {
        const realRepo = await realpath(repoRoot)
        if (!contained(realRepo, source)) throw new Error('The repository and source directory do not match.')
        workspace = await serial(realRepo, async () => {
          check()
          const head = (await git(realRepo, ['rev-parse', '--verify', 'HEAD'])).trim()
          const patch = await git(realRepo, ['diff', '--binary', 'HEAD', '--'])
          const untracked = (await git(realRepo, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).length
          if ((await git(realRepo, ['rev-parse', '--verify', 'HEAD'])).trim() !== head || hash(await git(realRepo, ['diff', '--binary', 'HEAD', '--'])) !== hash(patch)) throw new Error('The repository changed during preparation. The source tree is unchanged; inspect and retry.')
          const branch = 'blinky/task-' + hash(task.id).slice(0, 24), tree = join(parent, 'tree')
          const result: TaskWorkspace = { strategy: 'git-worktree', sourceCwd: source, path: join(tree, relative(realRepo, source)), manifest: manifestPath, createdAt: Date.now(), repoRoot: realRepo, branch, baseline: { head, trackedPatchSha256: hash(patch), untrackedCount: untracked } }
          manifest = { ...manifest, workspace: result }; await writeJsonNow(manifestPath, manifest); check()
          await git(realRepo, ['worktree', 'add', '-b', branch, tree, head]); check()
          if (patch) await applyPatch(tree, patch)
          await mkdir(result.path, { recursive: true }); check(); return result
        })
      } else { await mkdir(workspace.path, { recursive: false, mode: 0o700 }); check() }
    } else { await realpath(workspace.path); check() }
    manifest = { ...manifest, state: 'ready', workspace }; await writeJsonNow(manifestPath, manifest); check(); return workspace
  } catch (error) {
    await writeJsonNow(manifestPath, { ...manifest, state: 'failed', error: 'Preparation did not complete. Preserve these files and inspect before another attempt.' }).catch(() => {})
    throw new Error(`Task workspace could not be prepared. Work is retained at ${parent}. ${error instanceof Error ? error.message : ''}`)
  }
}

export function workspaceInstructions(workspace: TaskWorkspace): string {
  return `Task workspace: ${workspace.path}\nSource/input directory: ${workspace.sourceCwd}\nStrategy: ${workspace.strategy}${workspace.branch ? '\nBranch: ' + workspace.branch : ''}. Keep output in the assigned workspace. Do not clean, reset, merge or overwrite the source tree or other tasks. This directory assignment is not an OS sandbox; existing permissions and approvals still apply.${workspace.baseline?.untrackedCount ? '\nUntracked source files were not automatically copied. Read or copy only inputs needed for this task through the existing controlled tools.' : ''}\nReturn the actual output paths and branch so the lead can review the work without automatic merging.`
}
