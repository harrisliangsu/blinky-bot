/** Discovery only. No inherited credentials, real config, prompts or account actions. */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { nativeSkills, verifySkillRuntime } from '../src/main/skills/runtime.ts'

const root = await mkdtemp(join(tmpdir(), 'blinky-kimi-skills-')), home = join(root, 'home'), cwd = join(root, 'work')
await mkdir(home); await mkdir(cwd)
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', KIMI_CODE_HOME: join(home, '.kimi-code'), XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.data'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.state') }
const name = `blinky-kimi-fixture-${randomUUID()}`, dir = join(env.KIMI_CODE_HOME, 'skills', name)
await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Virtual discovery fixture.\n---\nDo not execute.\n`)
const result = { modelTurns: 0, isolatedHome: true, separateWorkspace: true, initialized: false, commands: [], protocolErrors: [], EMFILE: false }
try {
  await new Promise(resolve => {
    const child = spawn('kimi', ['acp'], { env, cwd, stdio: ['pipe','pipe','pipe'] })
    let settled = false, tail = ''
    const lines = createInterface({ input: child.stdout }), timer = setTimeout(() => finish('timeout'), 12000)
    function finish(reason) { if (settled) return; settled = true; result.reason = reason; clearTimeout(timer); lines.close(); child.stdin.end(); child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 1000); force.unref(); child.once('close', () => clearTimeout(force)); resolve() }
    child.stdin.on('error',()=>{}); child.on('error',()=>finish('spawn-error')); child.on('close',()=>finish('exit'))
    child.stderr.on('data', data => { tail = (tail + data.toString()).slice(-300); if (tail.includes('EMFILE')) result.EMFILE = true })
    const send = value => child.stdin.write(JSON.stringify(value)+'\n')
    lines.on('line', line => { let message; try { message=JSON.parse(line) } catch { return }
      if (message.id === 1) { result.initialized = !!message.result; result.version = message.result?.agentInfo?.version; if (message.error) return finish('initialize-error'); send({jsonrpc:'2.0',id:2,method:'session/new',params:{cwd,mcpServers:[]}}) }
      if (message.method === 'session/update' && message.params?.update?.sessionUpdate === 'available_commands_update') result.commands = message.params.update.availableCommands?.map(c=>({name:c.name,hasPath:typeof c.path==='string'})) ?? []
      if (message.id === 2) { if (message.error) result.protocolErrors.push({code:message.error.code,message:message.error.message}); setTimeout(()=>finish(message.error?'session-error':'session-created'),300) }
    })
    send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:1,clientCapabilities:{}}})
  })
  if (result.reason === 'session-created') {
    result.native = await nativeSkills('kimi',env,cwd,12000)
    result.fixtureAdvertised = result.native.some(skill => skill.name === name)
  }
  result.verification = await verifySkillRuntime(name,dir,[{agent:'Kimi Code',dir:join(env.KIMI_CODE_HOME,'skills'),enabled:true}],'present',{env,cwd,timeoutMs:12000})
  console.log(JSON.stringify(result,null,2))
} finally { await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100}) }
