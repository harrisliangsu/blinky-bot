/** Native discovery only: no prompt, model turn or auth-changing command. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { hydratedEnv } from '../backends/loginShellEnv'
import { type SkillSyncTarget } from './sync'

export interface NativeSkill { name: string; path?: string }
export interface SkillRuntimeCheck {
  skill: string
  agent: string
  operation: 'present' | 'removed'
  status: 'verified' | 'missing' | 'shadowed' | 'preserved' | 'stale' | 'unavailable' | 'unsupported' | 'error'
  detail: string
  checkedAt: number
}
export interface SkillVerificationReport { verification: SkillRuntimeCheck[] }
export interface RuntimeProbeOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
  timeoutMs?: number
  /** Isolated test adapter; production always spawns the installed CLI. */
  probe?: (agent: string, env: NodeJS.ProcessEnv, cwd: string) => Promise<NativeSkill[]>
}

class NativeDiscoveryUnavailable extends Error {
  constructor(readonly reason: 'authentication' | 'file-watching') { super('Native discovery unavailable.') }
}

function agentId(agent: string): string {
  if (agent.startsWith('Codex')) return 'codex'
  if (agent.startsWith('Claude Code')) return 'claude'
  if (agent.startsWith('Kimi')) return 'kimi'
  if (agent.startsWith('Grok')) return 'grok'
  if (agent.startsWith('pi')) return 'pi'
  if (agent.startsWith('OpenCode')) return 'opencode'
  return 'droid'
}

/** Each protocol must supply the discovered path, not merely echo a skill name. */
export async function nativeSkills(agent: string, env: NodeJS.ProcessEnv, cwd: string, timeoutMs = 20_000): Promise<NativeSkill[]> {
  const args = agent === 'codex' ? ['app-server']
    : agent === 'grok' ? ['inspect', '--json']
      : agent === 'kimi' ? ['acp']
        : agent === 'pi' ? ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve'] : null
  if (!args) throw new Error('unsupported')
  return new Promise((resolveResult, reject) => {
    const child = spawn(agent, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let settled = false, bytes = 0, output = '', diagnosticTail = '', watchUnavailable = false
    let kimiSkills: NativeSkill[] = []
    let kimiCreated = false, kimiCatalog = false
    const lines = createInterface({ input: child.stdout })
    const timer = setTimeout(() => finish(new Error('Native discovery timed out.')), timeoutMs)
    function finish(error?: Error, result: NativeSkill[] = []): void {
      if (settled) return
      settled = true; clearTimeout(timer)
      lines.close(); child.stdin.end(); child.kill('SIGTERM')
      const force = setTimeout(() => child.kill('SIGKILL'), 1000); force.unref()
      child.once('close', () => clearTimeout(force))
      error ? reject(error) : resolveResult(result)
    }
    function write(value: unknown): void { if (!settled) child.stdin.write(JSON.stringify(value) + '\n') }
    child.stdin.on('error', () => undefined)
    child.on('error', () => finish(new Error('Native discovery could not start.')))
    child.on('close', (code) => {
      if (settled) return
      if (watchUnavailable) return finish(new NativeDiscoveryUnavailable('file-watching'))
      if (agent !== 'grok' || code !== 0) return finish(new Error('Native discovery exited before returning a result.'))
      try {
        const body = JSON.parse(output) as { skills?: unknown }
        if (!Array.isArray(body.skills)) throw new Error('shape')
        finish(undefined, body.skills.map(skillEntry).filter(isSkill))
      } catch { finish(new Error('Native discovery returned an unsupported response.')) }
    })
    const count = (chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > 8 * 1024 * 1024) finish(new Error('Native discovery exceeded its output limit.'))
    }
    child.stderr.on('data', (chunk: Buffer) => {
      count(chunk)
      // Keep only a tiny rolling classifier; never expose CLI diagnostics/config.
      const combined = diagnosticTail + chunk.toString('utf8')
      if (combined.includes('EMFILE')) watchUnavailable = true
      diagnosticTail = combined.slice(-6)
    })
    child.stdout.on('data', (chunk: Buffer) => { count(chunk); if (agent === 'grok' && !settled) output += chunk.toString('utf8') })
    lines.on('line', (line) => {
      if (settled || agent === 'grok') return
      let m: any
      try { m = JSON.parse(line) } catch { return }
      if (agent === 'codex') {
        if (m.id === 1) {
          if (m.error || !m.result) return finish(new Error('Codex initialization failed.'))
          write({ method: 'initialized', params: {} })
          write({ id: 2, method: 'skills/list', params: { cwds: [cwd], forceReload: true } })
        }
        if (m.id === 2) {
          if (m.error || !Array.isArray(m.result?.data) || m.result.data.some((item: any) => !Array.isArray(item.skills) || item.errors?.length)) return finish(new Error('Codex skills could not be read completely.'))
          finish(undefined, m.result.data.flatMap((item: any) => item.skills).map(skillEntry).filter(isSkill))
        }
      } else if (agent === 'pi' && m.id === 'skills') {
        if (!m.success || !Array.isArray(m.data?.commands)) return finish(new Error('pi commands could not be read.'))
        finish(undefined, m.data.commands.filter((item: any) => typeof item.name === 'string' && item.name.startsWith('skill:')).map((item: any) => skillEntry({ ...item, name: item.name.slice(6) })).filter(isSkill))
      } else if (agent === 'kimi') {
        if (m.id === 1) {
          if (m.error || !m.result) return finish(new Error('Kimi initialization failed.'))
          write({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } })
        }
        if (m.method === 'session/update' && m.params?.update?.sessionUpdate === 'available_commands_update' && Array.isArray(m.params.update.availableCommands)) {
          kimiCatalog = true
          kimiSkills = m.params.update.availableCommands.map((item: any) => skillEntry({ ...item, name: typeof item.name === 'string' ? item.name.replace(/^\//, '').replace(/^skill:/, '') : '' })).filter(isSkill)
          if (kimiCreated) finish(undefined, kimiSkills)
        }
        if (m.id === 2) {
          if (m.error?.code === -32000 && /^authentication required$/i.test(m.error.message ?? '')) return finish(new NativeDiscoveryUnavailable('authentication'))
          if (m.error || !m.result) return finish(new Error('Kimi session discovery failed.'))
          // An absent notification is not an empty catalog or proof of removal.
          kimiCreated = true
          if (kimiCatalog) finish(undefined, kimiSkills)
        }
      }
    })
    if (agent === 'codex') write({ id: 1, method: 'initialize', params: { clientInfo: { name: 'blinky-skill-discovery', version: '1' } } })
    if (agent === 'kimi') write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
    if (agent === 'pi') write({ id: 'skills', type: 'get_commands' })
  })
}

function skillEntry(raw: any): NativeSkill | null {
  if (!raw || raw.enabled === false || typeof raw.name !== 'string') return null
  const path = [raw.path, raw.filePath, raw.location, raw.source, raw.source?.path, raw.sourceInfo?.path].find((value) => typeof value === 'string' && isAbsolute(value))
  return { name: raw.name, ...(path ? { path } : {}) }
}
function isSkill(value: NativeSkill | null): value is NativeSkill { return value !== null }
const digest = (value: Buffer): string => createHash('sha256').update(value).digest('hex')

async function skillFile(path: string): Promise<string> { return realpath(path.endsWith('SKILL.md') ? path : join(path, 'SKILL.md')) }

/** A new native scan is performed after every mutation; no previous success is reused. */
export async function verifySkillRuntime(
  name: string, expectedDir: string, targets: SkillSyncTarget[], operation: 'present' | 'removed', options: RuntimeProbeOptions = {}
): Promise<SkillRuntimeCheck[]> {
  const env = options.env ?? await hydratedEnv()
  const temporary = !options.cwd ? await mkdtemp(join(tmpdir(), 'blinky-discovery-')) : undefined
  const cwd = options.cwd ?? temporary!
  const unique = targets.filter((target, index) => targets.findIndex((other) => agentId(other.agent) === agentId(target.agent)) === index)
  let expectedFile: string | undefined, expectedDigest: string | undefined
  if (operation === 'present') {
    try {
      expectedFile = await skillFile(expectedDir)
      expectedDigest = digest(await readFile(expectedFile))
    } catch { /* Keep per-CLI failure evidence rather than throwing after mutation. */ }
  }
  try {
    // Bounded native scans do not execute a model turn. One failure does not
    // suppress the remaining installed agents' results.
    return await Promise.all(unique.map(async (target): Promise<SkillRuntimeCheck> => {
      const base = { skill: name, agent: target.agent, operation, checkedAt: Date.now() }
      if (!targets.some((other) => agentId(other.agent) === agentId(target.agent) && other.enabled)) return { ...base, status: 'unavailable', detail: 'CLI and skill root are unavailable.' }
      const id = agentId(target.agent)
      if (!['codex', 'grok', 'kimi', 'pi'].includes(id)) return { ...base, status: 'unsupported', detail: 'No verified source-path discovery adapter for this runtime/version; native skill loading was not verified.' }
      try {
        if (operation === 'present' && !expectedDigest) return { ...base, status: 'error', detail: 'Installed content could not be read back.' }
        const found = (await (options.probe ? options.probe(id, env, cwd) : nativeSkills(id, env, cwd, options.timeoutMs))).filter((item) => item.name === name)
        if (!found.length) return { ...base, status: operation === 'removed' ? 'verified' : 'missing', detail: operation === 'removed' ? 'Fresh native discovery no longer advertises this skill.' : 'Fresh native discovery did not advertise this skill.' }
        if (found.some((item) => !item.path)) return { ...base, status: 'unsupported', detail: 'CLI advertised the name without its source path; the active copy could not be verified.' }
        if (operation === 'removed') {
          const removedPaths = new Set([join(resolve(expectedDir), 'SKILL.md'), ...targets.filter((other) => agentId(other.agent) === id).map((other) => join(resolve(other.dir), name, 'SKILL.md'))])
          const stale = (await Promise.all(found.map(async (item) => {
            const file = item.path!.endsWith('SKILL.md') ? item.path! : join(item.path!, 'SKILL.md')
            const actual = await realpath(file).catch(() => undefined)
            return actual ? actual === join(resolve(expectedDir), 'SKILL.md') : removedPaths.has(resolve(file))
          }))).some(Boolean)
          // A conflicting, independently managed skill may legitimately remain.
          return { ...base, status: stale ? 'stale' : 'preserved', detail: stale ? 'Native discovery still advertises a removed or conflicting path; inspect the retained copy.' : 'Native discovery still advertises a separately managed copy; it was preserved.' }
        }
        const files = await Promise.all(found.map(async (item) => {
          const file = await skillFile(item.path!)
          return file === expectedFile && digest(await readFile(file)) === expectedDigest
        }))
        return { ...base, status: files.length === 1 && files[0] ? 'verified' : 'shadowed', detail: files.length === 1 && files[0] ? 'Fresh native discovery selected the installed path and current content.' : 'Native discovery selected another copy or multiple copies; existing files were preserved.' }
      } catch (error) {
        if (error instanceof NativeDiscoveryUnavailable) return { ...base, status: 'unavailable', detail: error.reason === 'authentication' ? 'Kimi ACP requires authentication before session discovery; runtime loading was not verified.' : 'Native discovery file watching is unavailable (EMFILE); runtime loading was not verified.' }
        return { ...base, status: 'error', detail: 'Native discovery failed, timed out, or returned an unreadable source. No model turn was run.' }
      }
    }))
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }) }
}

/** Bulk sync runs one fresh native scan per CLI after all link mutations. */
export async function verifySkillBatch(entries: Array<{ name: string; dir: string }>, targets: SkillSyncTarget[]): Promise<SkillRuntimeCheck[]> {
  const cwd = await mkdtemp(join(tmpdir(), 'blinky-discovery-batch-')), env = await hydratedEnv()
  const probes = new Map<string, Promise<NativeSkill[]>>()
  try {
    const result: SkillRuntimeCheck[] = []
    for (const entry of entries) result.push(...await verifySkillRuntime(entry.name, entry.dir, targets, 'present', { cwd, env, probe: (id) => {
      if (!probes.has(id)) probes.set(id, nativeSkills(id, env, cwd))
      return probes.get(id)!
    } }))
    return result
  } finally { await rm(cwd, { recursive: true, force: true }) }
}
