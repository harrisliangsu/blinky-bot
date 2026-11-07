import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import type { AgentTask } from '../../shared/types'
import { parseTaskPlan } from './planning.ts'
import { prepareTaskWorkspace, taskWorkspaceKey } from './workspaces.ts'
const exec = promisify(execFile)
test('independent Git tasks get distinct branches and tracked snapshots; source dirty/untracked and cancellation outcomes survive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-task-workspace-')), repo = join(root, 'repo'), previous = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = join(root, 'appdata')
  await mkdir(repo)
  const git = (...args: string[]) => exec('/usr/bin/git', ['-C', repo, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
  const make = (id: string): AgentTask => ({ id, botId: 'worker', requesterBotId: 'lead', sourceSessionId: 'source', sessionId: 'private-' + id, prompt: id, title: id, status: 'queued', createdAt: 1, updatedAt: 1, plan: parseTaskPlan({}, repo, 'source', 'lead', []) })
  try {
    await git('init'); await git('config', 'user.name', 'Synthetic'); await git('config', 'user.email', 'synthetic@example.invalid')
    await writeFile(join(repo, 'tracked.txt'), 'baseline'); await git('add', 'tracked.txt'); await git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Synthetic baseline')
    await writeFile(join(repo, 'tracked.txt'), 'existing dirty work'); await writeFile(join(repo, 'untracked.txt'), 'retained untracked input')
    const status = (await git('status', '--porcelain=v1')).stdout
    const tasks = [make('one'), make('two')]
    const [one, two] = await Promise.all(tasks.map(task => prepareTaskWorkspace(task, tasks, repo, () => true)))
    assert.equal(one.strategy, 'git-worktree'); assert.notEqual(one.path, two.path); assert.notEqual(one.branch, two.branch)
    assert.equal(await readFile(join(one.path, 'tracked.txt'), 'utf8'), 'existing dirty work')
    await assert.rejects(readFile(join(one.path, 'untracked.txt')), { code: 'ENOENT' })
    await writeFile(join(one.path, 'result.txt'), 'one'); await writeFile(join(two.path, 'result.txt'), 'two')
    assert.equal(await readFile(join(one.path, 'result.txt'), 'utf8'), 'one'); assert.equal(await readFile(join(two.path, 'result.txt'), 'utf8'), 'two')
    assert.equal((await git('status', '--porcelain=v1')).stdout, status)
    assert.equal(await readFile(join(repo, 'tracked.txt'), 'utf8'), 'existing dirty work'); assert.equal(await readFile(join(repo, 'untracked.txt'), 'utf8'), 'retained untracked input')
    const done = { ...tasks[0]!, workspace: one, status: 'completed' as const }, dependent = make('dependent'); dependent.plan = parseTaskPlan({ depends_on: [done.id] }, repo, 'source', 'lead', [done])
    const shared = await prepareTaskWorkspace(dependent, [done], repo, () => true)
    assert.equal(shared.strategy, 'shared'); assert.equal(shared.path, one.path)
    assert.equal(taskWorkspaceKey(dependent, [done]), taskWorkspaceKey(done, [done]))
    const continuation = { ...done, id: 'continuation', continuedFromTaskId: done.id }
    assert.equal((await prepareTaskWorkspace(continuation, [done], repo, () => true)).path, one.path)
    const cancelled = make('cancelled'); let checks = 0
    await assert.rejects(prepareTaskWorkspace(cancelled, [], repo, () => ++checks < 6), /cancelled|retained/)
    assert.equal((await git('status', '--porcelain=v1')).stdout, status)
    await assert.rejects(prepareTaskWorkspace(cancelled, [], repo, () => true), /previous workspace preparation/)
  } finally { if (previous === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = previous; await rm(root, { recursive: true, force: true }) }
})
test('non-Git tasks get private output directories; explicit source sharing is a separate host-approved decision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-directory-task-')), source = join(root, 'inputs'), previous = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = join(root, 'appdata'); await mkdir(source); await writeFile(join(source, 'input.txt'), 'do not move or copy all inputs')
  const make = (id: string): AgentTask => ({ id, botId: 'bot', sourceSessionId: 'source', sessionId: 'session-' + id, title: id, prompt: id, status: 'queued', createdAt: 1, updatedAt: 1, plan: parseTaskPlan({}, source, 'source', 'bot', []) })
  try {
    const one = await prepareTaskWorkspace(make('one'), [], source, () => true), two = await prepareTaskWorkspace(make('two'), [], source, () => true)
    assert.equal(one.strategy, 'directory'); assert.notEqual(one.path, two.path)
    await assert.rejects(readFile(join(one.path, 'input.txt')), { code: 'ENOENT' }); assert.equal(await readFile(join(source, 'input.txt'), 'utf8'), 'do not move or copy all inputs')
    const shared = make('shared'); shared.plan = parseTaskPlan({ workspace: 'shared', workspace_reason: 'The user requested editing the existing source file in place.' }, source, 'source', 'bot', [])
    assert.equal((await prepareTaskWorkspace(shared, [], source, () => true)).path, source)
    const legacy = make('legacy'); delete legacy.plan
    assert.equal((await prepareTaskWorkspace(legacy, [], source, () => true)).strategy, 'legacy')
  } finally { if (previous === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = previous; await rm(root, { recursive: true, force: true }) }
})
