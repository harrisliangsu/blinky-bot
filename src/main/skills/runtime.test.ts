import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { nativeSkills, verifySkillRuntime } from './runtime.ts'

test('Kimi separates auth and file-watch unavailability without echoing diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-kimi-status-'))
  try {
    const source = join(root,'source'), command = join(root,'kimi')
    await mkdir(source);await writeFile(join(source,'SKILL.md'),'fixture')
    await writeFile(command, `#!${process.execPath}\nrequire('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);console.log(JSON.stringify(m.id===1?{id:1,result:{}}:{id:2,error:{code:-32000,message:'Authentication required'}}))})`)
    await chmod(command,0o700)
    const target={agent:'Kimi',dir:root,enabled:true},options={env:{PATH:root},cwd:root,timeoutMs:3000}
    const auth=(await verifySkillRuntime('demo',source,[target],'present',options))[0]
    assert.equal(auth.status,'unavailable');assert.match(auth.detail,/requires authentication/)
    await writeFile(command, `#!${process.execPath}\nprocess.stderr.write('fixture-private-EM');setTimeout(()=>{process.stderr.write('FILE fixture-private');process.exit(1)},20)`)
    const watch=(await verifySkillRuntime('demo',source,[target],'present',options))[0]
    assert.equal(watch.status,'unavailable');assert.match(watch.detail,/EMFILE/);assert.ok(!watch.detail.includes('fixture-private'))
    await writeFile(command, `#!${process.execPath}\nrequire('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===1)console.log(JSON.stringify({id:1,result:{}}));else{console.log(JSON.stringify({method:'session/update',params:{update:{sessionUpdate:'available_commands_update',availableCommands:[{name:'/skill:demo',path:'/fixture/SKILL.md'}]}}}));console.log(JSON.stringify({id:2,result:{sessionId:'fixture'}}))}})`)
    assert.deepEqual(await nativeSkills('kimi',{PATH:root},root,3000),[{name:'demo',path:'/fixture/SKILL.md'}])
    await writeFile(command, `#!${process.execPath}\nrequire('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);console.log(JSON.stringify({id:m.id,result:{sessionId:'fixture'}}))})`)
    const absent=(await verifySkillRuntime('demo',source,[target],'removed',{...options,timeoutMs:700}))[0]
    assert.equal(absent.status,'error','no catalog notification must never verify removal')
  } finally { await rm(root,{recursive:true,force:true}) }
})

test('fresh native selection distinguishes current copy, shadowing, missing and unsupported hosts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-runtime-check-'))
  try {
    const expected = join(root, 'shared', 'demo'), other = join(root, 'user-copy', 'demo'), linked = join(root, 'codex', 'demo')
    await Promise.all([expected, other, join(root, 'codex')].map((dir) => mkdir(dir, { recursive: true })))
    await writeFile(join(expected, 'SKILL.md'), 'current version'); await writeFile(join(other, 'SKILL.md'), 'user version')
    await symlink(expected, linked)
    const targets = ['Codex', 'Grok', 'Kimi', 'pi', 'Claude Code'].map((agent) => ({ agent, dir: join(root, agent), enabled: true }))
    let calls = 0
    const probe = async (id: string) => {
      calls++
      return id === 'codex' ? [{ name: 'demo', path: join(linked, 'SKILL.md') }] : id === 'grok' ? [{ name: 'demo', path: other }] : id === 'kimi' ? [{ name: 'demo' }] : []
    }
    const result = await verifySkillRuntime('demo', expected, targets, 'present', { env: {}, cwd: root, probe })
    assert.deepEqual(result.map((item) => item.status), ['verified', 'shadowed', 'unsupported', 'missing', 'unsupported'])
    await writeFile(join(expected, 'SKILL.md'), 'updated version')
    assert.equal((await verifySkillRuntime('demo', expected, [targets[0]], 'present', { env: {}, cwd: root, probe }))[0].status, 'verified')
    assert.equal(calls, 5, 'update must perform a fresh scan')
    assert.equal(await readFile(join(other, 'SKILL.md'), 'utf8'), 'user version')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('removal verifies absence, flags a stale path and preserves another active copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-runtime-remove-'))
  try {
    const expected = join(root, 'shared', 'demo'), other = join(root, 'grok', 'demo')
    await mkdir(other, { recursive: true }); await writeFile(join(other, 'SKILL.md'), 'preserved')
    const targets = ['Codex', 'Grok', 'pi'].map((agent) => ({ agent, dir: join(root, agent.toLowerCase()), enabled: true }))
    const result = await verifySkillRuntime('demo', expected, targets, 'removed', { env: {}, cwd: root,
      probe: async (id) => id === 'codex' ? [] : [{ name: 'demo', path: id === 'grok' ? other : expected }] })
    assert.deepEqual(result.map((item) => item.status), ['verified', 'preserved', 'stale'])
    assert.equal(await readFile(join(other, 'SKILL.md'), 'utf8'), 'preserved')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('native errors never expose stdout, stderr, or credential-shaped messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-runtime-error-'))
  try {
    const expected = join(root, 'demo'); await mkdir(expected); await writeFile(join(expected, 'SKILL.md'), 'fixture')
    const result = await verifySkillRuntime('demo', expected, [{ agent: 'Grok', dir: root, enabled: true }], 'present', { env: {}, cwd: root, probe: async () => { throw new Error('fixture-secret-no-echo') } })
    assert.equal(result[0].status, 'error'); assert.ok(!JSON.stringify(result).includes('fixture-secret-no-echo'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Codex discovery uses skills/list with forceReload and ignores disabled skills without a model turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-native-protocol-'))
  try {
    const command = join(root, 'codex')
    await writeFile(command, `#!${process.execPath}\nconst readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({id:1,result:{}}));else if(m.method==='skills/list'&&m.params.forceReload===true)console.log(JSON.stringify({id:2,result:{data:[{skills:[{name:'demo',path:'/fixture/SKILL.md',enabled:true},{name:'disabled',path:'/disabled/SKILL.md',enabled:false}],errors:[]}]}}));else if(m.method!=='initialized')process.exit(2)})`)
    await chmod(command, 0o700)
    assert.deepEqual(await nativeSkills('codex', { PATH: root }, root, 5000), [{ name: 'demo', path: '/fixture/SKILL.md' }])
    const grok = join(root, 'grok')
    await writeFile(grok, `#!${process.execPath}\nconsole.log(JSON.stringify({skills:[{name:'demo',source:{type:'user',path:'/fixture/SKILL.md'}}]}))`)
    await chmod(grok, 0o700)
    assert.deepEqual(await nativeSkills('grok', { PATH: root }, root, 5000), [{ name: 'demo', path: '/fixture/SKILL.md' }])
    await writeFile(command, `#!${process.execPath}\nprocess.stderr.write('fixture-secret-no-echo');setInterval(()=>{},1000)`)
    await assert.rejects(nativeSkills('codex', { PATH: root }, root, 50), (error: Error) => !error.message.includes('fixture-secret-no-echo') && /timed out/.test(error.message))
  } finally { await rm(root, { recursive: true, force: true }) }
})
