import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const moduleUrl = pathToFileURL(resolve('src/main/store/memory.ts')).href
function run(root, code, killed = false, initialized = true) {
  const child = spawnSync(process.execPath, ['--experimental-transform-types','--import',resolve('scripts/register-ts.mjs'),'--input-type=module','-e',`import * as m from ${JSON.stringify(moduleUrl)}; ${initialized?'await m.loadMemory();':''} ${code}`], { env: { ...process.env, OPENBOT_DATA_DIR: root }, encoding: 'utf8' })
  if (killed) { assert.equal(child.signal, 'SIGKILL', child.stderr); return }
  assert.equal(child.status, 0, child.stderr)
  return JSON.parse(child.stdout.trim().split('\n').at(-1))
}
const old = '用户习惯使用蓝色杯子喝无糖花茶。', corrected = '用户习惯使用白色杯子喝无糖花茶。'

test('forget/edit persist across processes, suppress concurrent auto-writes and allow fresh explicit restore only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-forget-'))
  try {
    const first = run(root, `const e=await m.writeUserMemory('a',${JSON.stringify(old)},undefined,'request-1'); await m.addBotMemoryDurable('a','项目文档应该保留实际运行的验证记录。','run'); console.log(JSON.stringify(e))`)
    const removed = run(root, `const result=await Promise.allSettled([m.removeBotMemoryDurable('a',${JSON.stringify(first.id)}),m.addBotMemoryDurable('a',${JSON.stringify(old)},'run')]); console.log(JSON.stringify(result.map(x=>x.status)))`)
    assert.deepEqual(removed, ['fulfilled','rejected'])
    assert.equal(run(root, `console.log(JSON.stringify(m.listBotMemory('a').some(e=>e.text===${JSON.stringify(old)})))`), false)
    assert.equal(run(root, `console.log(JSON.stringify(await m.writeUserMemory('a',${JSON.stringify(old)},undefined,'request-1')))`), null)
    const restored = run(root, `console.log(JSON.stringify(await m.writeUserMemory('a',${JSON.stringify(old)},undefined,'request-2')))`)
    const edit = run(root, `console.log(JSON.stringify(await m.writeUserMemory('a',${JSON.stringify(corrected)},${JSON.stringify(restored.id)},'request-edit')))`)
    assert.equal(edit.text, corrected)
    assert.equal(run(root, `console.log(JSON.stringify(m.automaticMemoryBlocked('a',${JSON.stringify(old)})))`), true)
    const document = JSON.parse(await readFile(join(root,'memory/a.json'),'utf8'))
    assert.ok(document.entries.some(e=>e.text.includes('验证记录')))
    assert.equal(JSON.stringify(document.protection).includes(old), false)
    assert.equal(JSON.stringify(document.protection).includes(corrected), false)
    assert.equal(run(root, `let rejected=false;try{await m.writeUserMemory('a','登录密码是 fixture-password-only')}catch{rejected=true} console.log(JSON.stringify(rejected))`), true)
    assert.equal((await readFile(join(root,'memory/a.json'),'utf8')).includes('fixture-password-only'), false)
  } finally { await rm(root, { recursive:true, force:true }) }
})

test('shared preference deletion and correction reach all Bots and old message replay cannot restore it', async () => {
  const root = await mkdtemp(join(tmpdir(),'blinky-shared-forget-'))
  try {
    const entry = run(root, `console.log(JSON.stringify(await m.addUserPreference(${JSON.stringify(old)},'original-message')))`)
    run(root, `await m.removeBotMemoryDurable('b',${JSON.stringify(entry.id)}); console.log('true')`)
    const replay = run(root, `await m.addUserPreference(${JSON.stringify(old)},'original-message'); console.log(JSON.stringify([m.listBotMemory('a'),m.listBotMemory('b'),m.automaticMemoryBlocked('a',${JSON.stringify(old)})]))`)
    assert.deepEqual(replay,[[],[],true])
    const fresh = run(root, `console.log(JSON.stringify(await m.addUserPreference(${JSON.stringify(old)},'fresh-message')))`)
    run(root, `await m.writeUserMemory('a',${JSON.stringify(corrected)},${JSON.stringify(fresh.id)},'edit-shared'); console.log('true')`)
    const views = run(root, `console.log(JSON.stringify([m.listBotMemory('a').map(e=>e.text),m.listBotMemory('b').map(e=>e.text)]))`)
    assert.deepEqual(views,[[corrected],[corrected]])
  } finally { await rm(root, { recursive:true, force:true }) }
})

test('a later explicit remember instruction overrides an older forget in the intended Bot scope', async () => {
  const root=await mkdtemp(join(tmpdir(),'blinky-remember-intent-'))
  try {
    const entry=run(root,`console.log(JSON.stringify(await m.writeUserMemory('a',${JSON.stringify(old)})))`)
    run(root,`await m.removeBotMemoryDurable('a',${JSON.stringify(entry.id)});console.log('true')`)
    const preferencesUrl=pathToFileURL(resolve('src/main/agent/memoryPreferences.ts')).href
    const shared=run(root,`const {captureUserPreference}=await import(${JSON.stringify(preferencesUrl)});await captureUserPreference(${JSON.stringify('重新记住：'+old)},'new-explicit-intent');console.log(JSON.stringify(m.listUserPreferences().at(-1)))`)
    assert.equal(run(root,`console.log(JSON.stringify(m.automaticMemoryBlocked('a',${JSON.stringify(old)})))`),false)
    run(root,`await m.removeBotMemoryDurable('b',${JSON.stringify(shared.id)});console.log('true')`)
    const local=run(root,`await m.writeUserMemory('a',${JSON.stringify(old)});console.log(JSON.stringify([m.automaticMemoryBlocked('a',${JSON.stringify(old)}),m.automaticMemoryBlocked('b',${JSON.stringify(old)})]))`)
    assert.deepEqual(local,[false,true])
  } finally {await rm(root,{recursive:true,force:true})}
})

test('a process killed on either side of atomic rename loses no prior memory and never revives committed deletion', async () => {
  for (const after of [false,true]) {
    const root = await mkdtemp(join(tmpdir(),'blinky-forget-crash-'))
    try {
      const entry = run(root, `console.log(JSON.stringify(await m.writeUserMemory('a',${JSON.stringify(old)})))`)
      run(root, `const {promises:fs}=await import('node:fs');const rename=fs.rename;fs.rename=async(...a)=>{${after?'await rename(...a);':''}process.kill(process.pid,'SIGKILL')}; await m.removeBotMemoryDurable('a',${JSON.stringify(entry.id)});`,true)
      const observed = run(root, `console.log(JSON.stringify({entries:m.listBotMemory('a').map(e=>e.text),blocked:m.automaticMemoryBlocked('a',${JSON.stringify(old)})}))`)
      assert.deepEqual(observed,after?{entries:[],blocked:true}:{entries:[old],blocked:false})
    } finally { await rm(root,{recursive:true,force:true}) }
  }
})

test('protection migration preserves more than 500 legacy facts and refuses malformed metadata', async () => {
  const root = await mkdtemp(join(tmpdir(),'blinky-memory-migrate-'))
  try {
    await mkdir(join(root,'memory'))
    const entries=Array.from({length:501},(_,i)=>({id:`e-${i}`,botId:'a',text:`已有记忆条目 ${i}`,source:'user',createdAt:i+1}))
    await writeFile(join(root,'memory/a.json'),JSON.stringify({botId:'a',entries}))
    assert.equal(run(root,`const first=m.loadMemory();await m.loadMemory();console.log(JSON.stringify(m.listBotMemory('a').length));await first`,false,false),501)
    assert.equal(run(root,`await m.writeUserMemory('a','用户习惯每周整理长期项目的文档。');console.log(JSON.stringify(m.listBotMemory('a').length))`),502)
    const raw=JSON.parse(await readFile(join(root,'memory/a.json'),'utf8'));raw.protection.blocked=['invalid']
    const broken=JSON.stringify(raw);await writeFile(join(root,'memory/a.json'),broken)
    assert.equal(run(root,`let failed=false;try{await m.writeUserMemory('a','用户习惯使用中文书写项目说明。')}catch{failed=true}console.log(JSON.stringify(failed))`),true)
    assert.equal(await readFile(join(root,'memory/a.json'),'utf8'),broken)
  } finally { await rm(root,{recursive:true,force:true}) }
})
