import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { evaluate } from '../agent/approvalPolicy.ts'
import { defaultSettings } from '../settingsSchema.ts'
import { readFileTool } from './fs/readFile.ts'
import { listDirTool } from './fs/listDir.ts'
import { globTool } from './fs/globTool.ts'
import { grepTool } from './fs/grepTool.ts'
import { writeFileTool } from './fs/writeFile.ts'
import { editFileTool } from './fs/editFile.ts'
import { shellTool } from './shell/index.ts'
import type { ApprovalRequest, Settings } from '../../shared/types.ts'
import type { Tool, ToolContext } from './types.ts'

async function fixture(run: (root: string, cwd: string, outside: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'blinky-directory-test-'))
  const cwd = join(root, 'workspace'), outside = join(root, 'outside')
  try {
    await mkdir(cwd); await mkdir(outside)
    await writeFile(join(outside, 'fixture.txt'), 'directory fixture\n')
    await run(root, cwd, outside)
  } finally { await rm(root, { recursive: true, force: true }) }
}

function context(cwd: string, settings: Settings, toolName: string, target: string) {
  const prompts: ApprovalRequest[] = []
  const ctx: ToolContext = {
    sessionId: crypto.randomUUID(), botId: 'fixture', cwd,
    signal: new AbortController().signal, settings, emit() {},
    async requestApproval(request) {
      const verdict = evaluate(settings, toolName, target, new Set(), request.force)
      if (verdict.outcome === 'ask') prompts.push(request)
      return verdict.outcome === 'allow'
    }
  }
  return { ctx, prompts }
}

test('auto-run accesses sibling directories through all file tools and shell without a card', async () => {
  await fixture(async (_root, cwd, outside) => {
    const file = join(outside, 'fixture.txt')
    const cases: Array<[Tool, Record<string, unknown>, string]> = [
      [listDirTool, { path: outside }, outside],
      [readFileTool, { path: file }, file],
      [globTool, { path: outside, pattern: '*.txt' }, outside],
      [grepTool, { path: outside, pattern: 'directory fixture' }, outside],
      [writeFileTool, { path: join(outside, 'new.txt'), content: 'new fixture' }, join(outside, 'new.txt')],
      [editFileTool, { path: file, old_string: 'directory fixture', new_string: 'edited fixture' }, file],
      [shellTool, { command: 'pwd', cwd: outside }, 'pwd'],
      [shellTool, { command: `cat '${file}'` }, `cat '${file}'`]
    ]
    for (const [tool, args, target] of cases) {
      const { ctx, prompts } = context(cwd, defaultSettings(), tool.schema.name, target)
      const result = await tool.handler(args, ctx)
      assert.equal(result.ok, true, result.output)
      assert.equal(prompts.length, 0, tool.schema.name)
    }
    assert.equal(await readFile(file, 'utf8'), 'edited fixture\n')
    assert.equal(await readFile(join(outside, 'new.txt'), 'utf8'), 'new fixture')
  })
})

test('explicit prompting policies still confirm outside directory access', async () => {
  await fixture(async (_root, cwd, outside) => {
    for (const policy of ['ask-every-time', 'ask-first-time'] as const) {
      const { ctx, prompts } = context(cwd, { ...defaultSettings(), approvalPolicy: policy }, 'list_dir', outside)
      assert.equal((await listDirTool.handler({ path: outside }, ctx)).ok, false)
      assert.equal(prompts.length, 1)
      assert.equal(prompts[0].force, true)
    }
  })
})

test('auto-run still refuses denied directory targets and confirms high-risk shell commands', async () => {
  await fixture(async (_root, cwd, outside) => {
    const denied = context(cwd, { ...defaultSettings(), denylist: [outside] }, 'list_dir', outside)
    assert.equal((await listDirTool.handler({ path: outside }, denied.ctx)).ok, false)
    assert.equal(denied.prompts.length, 0)
    const risky = context(cwd, defaultSettings(), 'shell', 'rm fixture.txt')
    const result = await shellTool.handler({ command: 'rm fixture.txt', cwd: outside }, risky.ctx)
    assert.equal(result.ok, false)
    assert.equal(risky.prompts.length, 1)
    assert.equal(risky.prompts[0].force, true)
    assert.equal(await readFile(join(outside, 'fixture.txt'), 'utf8'), 'directory fixture\n')
  })
})

test('relative traversal still fails and symlink destinations still follow the selected policy', async () => {
  await fixture(async (_root, cwd, outside) => {
    await symlink(outside, join(cwd, 'link'))
    const automatic = context(cwd, defaultSettings(), 'read_file', 'link/fixture.txt')
    assert.equal((await readFileTool.handler({ path: 'link/fixture.txt' }, automatic.ctx)).ok, true)
    const interactive = context(cwd, { ...defaultSettings(), approvalPolicy: 'ask-every-time' }, 'read_file', 'link/fixture.txt')
    assert.equal((await readFileTool.handler({ path: 'link/fixture.txt' }, interactive.ctx)).ok, false)
    assert.equal(interactive.prompts.length, 1)
    assert.match(interactive.prompts[0].detail, /outside/)
    assert.equal((await readFileTool.handler({ path: '../outside/fixture.txt' }, automatic.ctx)).ok, false)
  })
})

test('auto-run directory access does not become a standing grant after a policy change', async () => {
  await fixture(async (_root, cwd, outside) => {
    const { ctx, prompts } = context(cwd, defaultSettings(), 'list_dir', outside)
    assert.equal((await listDirTool.handler({ path: outside }, ctx)).ok, true)
    ctx.settings!.approvalPolicy = 'ask-every-time'
    assert.equal((await listDirTool.handler({ path: outside }, ctx)).ok, false)
    assert.equal(prompts.length, 1)
  })
})
