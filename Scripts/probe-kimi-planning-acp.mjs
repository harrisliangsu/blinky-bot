// Minimal real ACP/provider diagnostic, no app task mutation or business tools.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { connectionTestEnvironment } from '../src/main/connectors/testEnvironment.mjs'
import { redactPrivateText } from '../src/main/backends/secretRedaction.ts'

const root = process.env.BLINKY_KIMI_PROBE_ROOT
await fs.mkdir(root, { recursive: true })
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-kimi-probe-')), sourceHome = process.env.HOME
await fs.chmod(profile, 0o700)
const original = await fs.readFile(path.join(sourceHome, '.kimi-code/config.toml'))
const selectedModel = process.env.BLINKY_KIMI_MODEL
const info = JSON.parse(execFileSync('/opt/homebrew/bin/python3.11', ['Scripts/fixtures/prepare-planning-profile.py', '--kind', 'kimi', '--dest', profile, '--source-home', sourceHome, ...(selectedModel ? ['--model', selectedModel] : [])], { encoding: 'utf8' }))
const config = await fs.readFile(path.join(profile, 'config.toml'), 'utf8')
const secrets = [...config.matchAll(/"api_key"\s*=\s*("(?:[^"\\]|\\.)*")/g)].map(match => JSON.parse(match[1]))
const scrub = value => {
  let text = String(value); for (const secret of secrets) text = text.split(secret).join('[redacted]')
  const safe = item => typeof item === 'string' ? redactPrivateText(item) : Array.isArray(item) ? item.map(safe) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, val]) => [key, safe(val)])) : item
  try { return JSON.stringify(safe(JSON.parse(text)), null, 2) } catch { return redactPrivateText(text) }
}
const env = await connectionTestEnvironment(root)
env.KIMI_CODE_HOME = profile
env.KIMI_DISABLE_TELEMETRY = '1'
for (const name of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy']) if (process.env[name]) env[name] = process.env[name]
const child = spawn(path.join(sourceHome, '.kimi-code/bin/kimi'), ['acp'], { cwd: root, env, stdio: ['pipe','pipe','pipe'] })
const pending = new Map(), events = [], result = { nativeKimi: true, model: info.model, credentialMode: info.credentialMode, credentialValuesCopied: info.credentialValuesCopied, noMcpServers: true, permissionsDenied: 0, text: '', metadata: events }
let sequence = 0, buffer = '', stderr = ''
child.stderr.on('data', data => { stderr += data })
child.stdout.on('data', data => {
  buffer += data
  for (;;) {
    const end = buffer.indexOf('\n'); if (end < 0) break
    const line = buffer.slice(0,end); buffer = buffer.slice(end+1)
    let value; try { value = JSON.parse(line) } catch { continue }
    events.push({ method: value.method, id: value.id, update: value.params?.update?.sessionUpdate, stopReason: value.result?.stopReason, model: value.result?.configOptions?.find(option => option.id === 'model')?.currentValue, error: value.error })
    if (value.method === 'session/request_permission') { result.permissionsDenied++; child.stdin.write(JSON.stringify({ jsonrpc:'2.0',id:value.id,result:{outcome:{outcome:'cancelled'}} })+'\n') }
    if (value.params?.update?.sessionUpdate === 'agent_message_chunk') result.text += value.params.update.content?.text ?? ''
    if (pending.has(value.id)) { const item=pending.get(value.id); pending.delete(value.id); value.error ? item.reject(new Error(JSON.stringify(value.error))) : item.resolve(value.result) }
  }
})
child.on('exit', code => { for (const item of pending.values()) item.reject(new Error('ACP exited ' + code)); pending.clear() })
const rpc = (method, params) => new Promise((resolve,reject)=>{ const id=++sequence;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n') })
const deadline = setTimeout(()=>{result.timedOut=true;child.kill('SIGTERM')},90000)
try {
  await rpc('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'Blinky planning diagnosis',version:'1'}})
  const session = await rpc('session/new',{cwd:root,mcpServers:[]})
  result.sessionCreated = !!session.sessionId
  const selected = await rpc('session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: info.model })
  result.confirmedModel = selected.configOptions?.find(option => option.id === 'model')?.currentValue
  if (result.confirmedModel !== info.model) throw new Error('Kimi did not confirm the selected existing model')
  const response = await rpc('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'只回复 READY。不要使用任何工具。'}]})
  result.stopReason=response.stopReason;result.publicReply=!!result.text.trim()
} catch(error) { result.error=scrub(error.message) }
finally {
  clearTimeout(deadline); child.kill('SIGTERM')
  await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(2000)])
  result.sourceConfigurationUnchanged=(await fs.readFile(path.join(sourceHome,'.kimi-code/config.toml'))).equals(original)
  await fs.rm(profile,{recursive:true,force:true,maxRetries:20,retryDelay:250})
  result.temporaryProfileRemoved=!await fs.stat(profile).catch(()=>null)
  await fs.writeFile(path.join(root,'result.json'),scrub(JSON.stringify(result,null,2)))
  await fs.writeFile(path.join(root,'stderr.log'),scrub(stderr))
  console.log(JSON.stringify({publicReply:result.publicReply,timedOut:result.timedOut,stopReason:result.stopReason,result:path.join(root,'result.json')}))
}
