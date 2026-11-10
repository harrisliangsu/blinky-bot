/** Real native CLIs, disposable homes/configs and no real credentials or model turn. */
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { syncSkillLinks, removeSkillLinks } from '../src/main/skills/sync.ts'
import { verifySkillRuntime } from '../src/main/skills/runtime.ts'

const root = await mkdtemp(join(tmpdir(), 'blinky-native-isolated-')), name = `blinky-fixture-${randomUUID()}`
const shared = join(root, '.agents', 'skills'), source = join(shared, name)
const env = {
  PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(), LANG: 'en_US.UTF-8',
  XDG_CONFIG_HOME: join(root, '.config'), XDG_DATA_HOME: join(root, '.local', 'share'), XDG_CACHE_HOME: join(root, '.cache'), XDG_STATE_HOME: join(root, '.local', 'state'),
  CODEX_HOME: join(root, '.codex'), CLAUDE_CONFIG_DIR: join(root, '.claude'), KIMI_CODE_HOME: join(root, '.kimi'), GROK_HOME: join(root, '.grok'), PI_CODING_AGENT_DIR: join(root, '.pi', 'agent')
}
const commandExists = async (command) => {
  for (const dir of (env.PATH ?? '').split(delimiter)) try { await access(join(dir, command), constants.X_OK); return true } catch {}
  return false
}
const candidates = [['Codex', 'codex', env.CODEX_HOME], ['Grok', 'grok', env.GROK_HOME], ['Kimi', 'kimi', env.KIMI_CODE_HOME], ['pi', 'pi', env.PI_CODING_AGENT_DIR], ['Claude Code', 'claude', env.CLAUDE_CONFIG_DIR]]
const targets = await Promise.all(candidates.map(async ([agent, command, home]) => ({ agent, dir: join(home, 'skills'), enabled: await commandExists(command) })))
try {
  await mkdir(source, { recursive: true }); await mkdir(env.CODEX_HOME, { recursive: true })
  const content = (version) => `---\nname: ${name}\ndescription: Disposable native discovery fixture version ${version}.\n---\nDo not run tools. This fixture is for discovery only.\n`
  await writeFile(join(source, 'SKILL.md'), content(1))
  const linked = await syncSkillLinks(shared, name, targets)
  assert.ok(linked.every((item) => ['linked', 'unavailable'].includes(item.status)))
  const installed = await verifySkillRuntime(name, source, targets, 'present', { env, cwd: root, timeoutMs: 25000 })
  await writeFile(join(source, 'SKILL.md'), content(2))
  const updated = await verifySkillRuntime(name, source, targets, 'present', { env, cwd: root, timeoutMs: 25000 })
  for (const target of targets.filter((item) => item.enabled)) assert.equal(await readFile(join(target.dir, name, 'SKILL.md'), 'utf8'), content(2))
  await removeSkillLinks(shared, name, targets); await rm(source, { recursive: true })
  const removed = await verifySkillRuntime(name, source, targets, 'removed', { env, cwd: root, timeoutMs: 25000 })
  console.log(JSON.stringify({ realNativeCLIs: true, isolatedHomes: true, modelTurns: 0, installed, updated, removed }, null, 2))
  assert.equal(installed.find((item) => item.agent === 'Codex')?.status, 'verified')
  assert.equal(updated.find((item) => item.agent === 'Codex')?.status, 'verified')
  assert.equal(removed.find((item) => item.agent === 'Codex')?.status, 'verified')
} finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
