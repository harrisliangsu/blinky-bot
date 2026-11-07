/** Unique temporary skill: verify host links and native discovery. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { installSkill, uninstallSkill } from '../src/main/skills/index.ts'

const name = `blinky-sync-test-${randomUUID()}`
const root = await mkdtemp(path.join(os.tmpdir(), 'blinky-skill-native-'))
const source = path.join(root, 'SKILL.md')
await writeFile(source, `---\nname: ${name}\ndescription: Isolated temporary discovery test.\n---\nThis is a temporary local test.\n`)
let installed = false
let createdLinks = []
try {
  const result = await installSkill(root)
  if (!result.ok) throw new Error(result.error)
  installed = true
  createdLinks = (result.sync ?? []).filter((item) => item.status === 'linked').map((item) => item.path)
  const errors = (result.sync ?? []).filter((item) => item.status === 'conflict' || item.status === 'error')
  if (errors.length) throw new Error(`Temporary skill did not sync: ${errors.map((item) => item.agent + ': ' + item.status).join(', ')}`)
  for (const item of result.sync ?? []) if (item.status === 'linked' || item.status === 'existing') assert.equal(await readFile(path.join(item.path, 'SKILL.md'), 'utf8'), await readFile(source, 'utf8'))

  const grok = await new Promise((resolve, reject) => {
    const child = spawn('grok', ['inspect', '--json'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => { output += chunk })
    child.on('error', reject); child.on('close', (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error('Grok inspect failed.')))
  })
  const grokSkill = grok.skills?.find((skill) => skill.name === name)
  const grokFound = Boolean(grokSkill)

  const codexFound = await new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server'], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] })
    let settled = false
    const timer = setTimeout(() => finish(new Error('Codex skill discovery timed out.')), 30000)
    function finish(error, value) { if(settled)return;settled=true;clearTimeout(timer);child.kill('SIGTERM');error?reject(error):resolve(value) }
    child.on('error', (error) => finish(error));child.on('exit', (code) => { if(!settled)finish(new Error(`Codex exited early: ${code}`)) })
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let message;try { message=JSON.parse(line) } catch { return }
      if(message.id===1 && message.result) {child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');child.stdin.write(JSON.stringify({id:2,method:'skills/list',params:{cwds:[root],forceReload:true}})+'\n')}
      if(message.id===2) {if(message.error)finish(new Error('Codex skills/list failed.'));else finish(null,message.result?.data?.flatMap((entry)=>entry.skills??[]).find((skill)=>skill.name===name)??null)}
    })
    child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'blinky-skill-test',version:'1'}}})+'\n')
  })
  const piFound = await new Promise((resolve, reject) => {
    const child = spawn('pi', ['--mode','rpc','--no-session','--no-extensions','--no-prompt-templates','--no-themes','--no-context-files','--no-approve'], { cwd: root, stdio: ['pipe','pipe','ignore'] })
    let settled=false;const timer=setTimeout(()=>finish(new Error('pi skill discovery timed out.')),30000)
    function finish(error,value){if(settled)return;settled=true;clearTimeout(timer);child.kill('SIGTERM');error?reject(error):resolve(value)}
    child.on('error',(error)=>finish(error));child.on('exit',(code)=>{if(!settled)finish(new Error(`pi exited early: ${code}`))})
    readline.createInterface({input:child.stdout}).on('line',(line)=>{let message;try{message=JSON.parse(line)}catch{return}if(message.id==='skills'){if(!message.success)finish(new Error('pi get_commands failed.'));else finish(null,message.data?.commands?.some((command)=>command.name===`skill:${name}`)===true)}})
    child.stdin.write(JSON.stringify({id:'skills',type:'get_commands'})+'\n')
  })
  const kimiFound = await new Promise((resolve, reject) => {
    const child=spawn('kimi',['acp'],{cwd:root,stdio:['pipe','pipe','ignore']});let settled=false,found=false,created=false
    const timer=setTimeout(()=>finish(new Error('Kimi skill discovery timed out.')),30000)
    function finish(error,value){if(settled)return;settled=true;clearTimeout(timer);child.kill('SIGTERM');error?reject(error):resolve(value)}
    child.on('error',error=>finish(error));child.on('exit',code=>{if(!settled)finish(new Error(`Kimi exited early: ${code}`))})
    readline.createInterface({input:child.stdout}).on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}
      if(m.method==='session/update'&&m.params?.update?.sessionUpdate==='available_commands_update')found ||= m.params.update.availableCommands?.some(command=>command.name===name||command.name===`skill:${name}`||command.name===`/${name}`)===true
      if(m.id===1&&m.result)child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'session/new',params:{cwd:root,mcpServers:[]}})+'\n')
      if(m.id===2){if(m.error)finish(new Error('Kimi session/new failed.'));else{created=true;setTimeout(()=>finish(null,found),1000)}}
    })
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:1,clientCapabilities:{}}})+'\n')
  })
  console.log(JSON.stringify({ linkedDirectories: (result.sync ?? []).filter((item) => item.status === 'linked' || item.status === 'existing').map((item) => item.agent), grokNativeDiscovery:grokFound, grokSource:grokSkill?.source, codexNativeDiscovery:Boolean(codexFound), codexPath:codexFound?.path, piNativeDiscovery:piFound, kimiNativeDiscovery:kimiFound }))
  assert.ok(grokFound && codexFound && piFound && kimiFound, 'native discovery did not find the temporary skill')
} finally {
  if (installed) {
    const removed = await uninstallSkill(`agents:${name}`)
    if (!removed.ok) throw new Error(`Could not clean up temporary skill ${name}: ${removed.error}`)
    for (const link of createdLinks) if (await lstat(link).then(() => true, () => false)) throw new Error(`Temporary link was not removed: ${link}`)
  }
  await rm(root, { recursive: true, force: true })
}
