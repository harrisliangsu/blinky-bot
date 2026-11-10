import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

// Bundle the real scheduler, admission locks, task JSON and SQLite sessions.
// Replace only model execution, GUI fan-out, routine notification leases and
// chat-queue queries. Nothing imports a running app or its data directory.
const mocks = {
  // Inspection-only ledgers must not load an Electron/native judgment runtime.
  './tasks/coordinationPermission': 'export const communicationPermissionStatus=async()=>null',
  './tasks/progressTurn': 'export const taskJudgmentStatus=async()=>null',
  './ipc/broadcast': 'export const broadcast=e=>globalThis.__taskPool.events.push(e);export const postActivity=()=>{}',
  '../ipc/broadcast': 'export const broadcast=e=>globalThis.__taskPool.events.push(e);export const postActivity=()=>{}',
  './ipc/agentRuntime': 'export const loopFn=async name=>name==="sendMessage"?globalThis.__taskPool.send:name==="stopSession"?globalThis.__taskPool.stop:async()=>false',
  './agent/messageQueueRuntime': 'export const isQueueDraining=()=>false;export const isQueueSuspended=()=>false;export const queueSuspensionGeneration=()=>0',
  './routines/notifications': 'export const manageRoutineTaskResult=async()=>()=>{}'
}
async function compile(smallBounds = false) {
const boundaries = { ...mocks, ...(smallBounds ? { './tasks/limits': 'export const MAX_CONCURRENT_RUNS=4,MAX_QUEUED_TASKS=128,MAX_QUEUED_TASKS_PER_BOT=32' } : {}) }
return build({ stdin: { contents: `export * from './tasks.ts';export * from './tasks/limits.ts';export * from './store/tasks.ts';export * from './store/sessions.ts';export * from './store/bots.ts';export {ensureBotHome} from './store/botHome.ts';export {flushAll} from './store/jsonStore.ts';export {start,abortAll} from './agent/cancel.ts';`, resolveDir: resolve('src/main'), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'no-app-or-model', setup(b) {
    b.onResolve({ filter: /.*/ }, a => Object.hasOwn(boundaries, a.path) ? { path: a.path, namespace: 'fixture' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: boundaries[a.path], loader: 'js' }))
  } }]
})
}
const bundle=await compile(true), productionBundle=await compile()
async function until(predicate) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error('Isolated task scheduler did not reach the expected boundary')
}
async function fixture(production = false) {
  const root = await mkdtemp(join(tmpdir(), 'blinky-task-pool-')), previous = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  const module = join(root, 'runtime.mjs')
  await writeFile(module, (production ? productionBundle : bundle).outputFiles[0].contents)
  const state = globalThis.__taskPool = { events: [], calls: [], stops: [], gates: new Map(), active: 0, maximum: 0, perSession: new Map(), sessionMaximum: 0 }
  const api = await import(pathToFileURL(module).href)
  await api.loadSessions(); await api.loadTasks()
  const bots = [], homes = []
  function bot() {
    const b = api.createBot({ name: `Worker ${bots.length}`, backendId: 'codex', modelId: 'fixture-model', followsDefault: false, executionAgent: { backendId: 'codex', modelId: 'fixture-model' } })
    const home = api.ensureBotHome(b.id)
    api.saveSession({ ...home, cwd: root, mode: 'agent' })
    // Results must wait for this fixture's busy lead, never trigger a model.
    api.start(home.id)
    bots.push(b); homes.push(home)
    return b
  }
  bot()
  state.send = async (id, prompt) => {
    state.calls.push({ id, prompt }); state.active++; state.maximum = Math.max(state.maximum, state.active)
    const live = (state.perSession.get(id) ?? 0) + 1
    state.perSession.set(id, live); state.sessionMaximum = Math.max(state.sessionMaximum, live)
    try {
      await new Promise((release, reject) => state.gates.set(id, { release, reject }))
      const session = api.getSession(id)
      api.saveSession({ ...session, messages: [...session.messages, { id: crypto.randomUUID(), role: 'assistant', content: 'isolated executor result', createdAt: Date.now() }] })
    } finally { state.gates.delete(id); state.active--; state.perSession.set(id, state.perSession.get(id) - 1) }
  }
  // Deliberately leave the executor alive after stop is requested: the pool
  // must wait for cleanup before admitting a replacement into its slot.
  state.stop = async id => { state.stops.push(id) }
  const create = (b = bots[0], prompt = crypto.randomUUID()) => api.startBackgroundTask(b.id, prompt)
  const release = task => { assert.ok(state.gates.has(task.sessionId)); state.gates.get(task.sessionId).release() }
  async function close() {
    const active=api.listTasks().filter(t=>['queued','running'].includes(t.status))
    for(let i=0;i<active.length;i+=16)await Promise.all(active.slice(i,i+16).map(t=>api.cancelBackgroundTask(t.id)))
    for (const gate of state.gates.values()) gate.release()
    await until(() => state.active === 0)
    await new Promise(resolve => setTimeout(resolve, 30))
    await api.flushAll(); api.abortAll()
    if (previous === undefined) delete process.env.OPENBOT_DATA_DIR
    else process.env.OPENBOT_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
  return { root, module, api, state, bots, homes, bot, create, release, close }
}

test('four real scheduler stubs run, fifth waits; release, queued cancel, running cancel and failure advance safely', async () => {
  const f = await fixture(), { api, state } = f
  try {
    const tasks = await Promise.all(Array.from({ length: 6 }, () => f.create()))
    await until(() => state.calls.length === 4)
    assert.equal(state.active, 4)
    assert.equal(api.getTask(tasks[4].id).status, 'queued')
    assert.equal(api.countQueuedTasks(), 2)
    f.release(tasks[0]); await until(() => state.calls.length === 5)
    assert.equal(state.calls[4].id, tasks[4].sessionId)
    await api.cancelBackgroundTask(tasks[5].id)
    assert.equal(state.calls.some(c => c.id === tasks[5].sessionId), false)
    const seventh = await f.create()
    await api.cancelBackgroundTask(tasks[1].id)
    assert.ok(state.stops.includes(tasks[1].sessionId))
    assert.equal(state.active, 4)
    assert.equal(api.getTask(seventh.id).status, 'queued')
    f.release(tasks[1]); await until(() => state.calls.length === 6)
    assert.equal(api.getTask(tasks[1].id).status, 'cancelled')
    assert.equal(state.calls[5].id, seventh.sessionId)
    const eighth = await f.create()
    state.gates.get(tasks[2].sessionId).reject(new Error('isolated executor failed'))
    await until(() => state.calls.length === 7)
    assert.equal(api.getTask(tasks[2].id).status, 'failed')
    assert.equal(state.calls[6].id, eighth.sessionId)
    assert.equal(state.maximum, 4)
    assert.equal(state.sessionMaximum, 1)
  } finally { await f.close() }
})

test('scaled per-Bot bound admits 32 waiting plus 4 executing; concurrent admission stays bounded', async () => {
  const f = await fixture(), { api, state } = f
  try {
    await Promise.all(Array.from({ length: 4 }, () => f.create()))
    await until(() => state.active === 4)
    const results = await Promise.allSettled(Array.from({ length: 40 }, () => f.create()))
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 32)
    assert.equal(results.filter(r => r.status === 'rejected').length, 8)
    assert.equal(api.countQueuedTasks(f.bots[0].id), 32)
    assert.equal(api.countActiveTasks(f.bots[0].id), 36)
    const waiting = api.listTasks().find(t => t.status === 'queued')
    await api.cancelBackgroundTask(waiting.id)
    assert.equal(api.countQueuedTasks(), 31)
    await f.create()
    assert.equal(api.countQueuedTasks(), 32)
    assert.equal(state.maximum, 4)
  } finally { await f.close() }
})

test('scaled global bound holds 128 waiting plus 4 running and cannot race past its bound', async () => {
  const f = await fixture(), { api, state } = f
  try {
    const running = await Promise.all(Array.from({ length: 4 }, () => f.create()))
    await until(() => state.active === 4)
    while (f.bots.length < 5) f.bot()
    await Promise.all(f.bots.slice(0, 4).flatMap(b => Array.from({ length: 32 }, () => f.create(b))))
    assert.equal(api.countQueuedTasks(), 128)
    assert.equal(api.countActiveTasks(), 132)
    await assert.rejects(f.create(f.bots[4]), /128 waiting tasks/)
    f.release(running[0]); await until(() => state.calls.length === 5)
    assert.equal(api.countQueuedTasks(), 127)
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => f.create(f.bots[4])))
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(api.countQueuedTasks(), 128)
    assert.equal(state.maximum, 4)
  } finally { await f.close() }
})

test('all four creation paths enforce waiting capacity and preserve continuation idempotency', async () => {
  const f = await fixture(), { api, state } = f
  try {
    const worker = f.bots[0], lead = f.bot(), home = f.homes[0]
    api.saveSession({ ...api.getSession(home.id), botIds: [worker.id, lead.id] })
    await Promise.all(Array.from({ length: 4 }, () => f.create()))
    await until(() => state.active === 4)
    const session = api.createSession([worker.id])
    const previous = await api.createTaskRecordDurable(worker.id, session.id, 'original objective', 'previous', { sourceSessionId: home.id, executionAgent: worker.executionAgent })
    api.completeAgentTask(previous.id, 'previous result')
    await Promise.all(Array.from({ length: 32 }, () => api.delegateBackgroundTask(home.id, worker.id, worker.id, 'self-delegation')))
    assert.equal(api.countQueuedTasks(worker.id), 32)
    await assert.rejects(f.create(), /32 background tasks waiting/)
    await assert.rejects(api.delegateBackgroundTask(home.id, worker.id, worker.id, 'self'), /waiting in the queue/)
    await assert.rejects(api.delegateBackgroundTask(home.id, lead.id, worker.id, 'teammate'), /waiting in the queue/)
    await assert.rejects(api.delegateBackgroundTask(home.id, worker.id, worker.id, 'continue', undefined, previous.id), /waiting in the queue/)
    await api.cancelBackgroundTask(api.listTasks().find(t => t.status === 'queued').id)
    const continued = await Promise.allSettled(Array.from({ length: 8 }, () => api.delegateBackgroundTask(home.id, worker.id, worker.id, 'continue', undefined, previous.id)))
    assert.equal(continued.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(api.listTasks().filter(t => t.continuedFromTaskId === previous.id).length, 1)
    assert.equal(api.countQueuedTasks(worker.id), 32)
    assert.equal(state.maximum, 4)
  } finally { await f.close() }
})

test('same-session continuations remain mutually exclusive and do not block other free slots', async () => {
  const f = await fixture(), { api, state } = f
  try {
    const worker = f.bots[0], home = f.homes[0], session = api.createSession([worker.id])
    const parents = await Promise.all(['one', 'two'].map(prompt => api.createTaskRecordDurable(worker.id, session.id, prompt, prompt, { sourceSessionId: home.id, executionAgent: worker.executionAgent })))
    for (const parent of parents) api.completeAgentTask(parent.id, 'returned')
    const first = await api.delegateBackgroundTask(home.id, worker.id, worker.id, 'first', undefined, parents[0].id)
    await until(() => state.calls.length === 1)
    const second = await api.delegateBackgroundTask(home.id, worker.id, worker.id, 'second', undefined, parents[1].id)
    assert.equal(api.getTask(second.id).status, 'queued')
    await Promise.all(Array.from({ length: 3 }, () => f.create()))
    await until(() => state.active === 4)
    f.release(first); await until(() => state.calls.length === 5)
    assert.equal(api.getTask(second.id).status, 'running')
    assert.equal(state.sessionMaximum, 1)
    assert.equal(state.maximum, 4)
  } finally { await f.close() }
})

test('fresh Node recovery marks queued/running work uncertain without re-executing it', async () => {
  const f = await fixture(), { api } = f
  try {
    const extra = { sourceSessionId: f.homes[0].id, executionAgent: f.bots[0].executionAgent }
    const queued = await api.createTaskRecordDurable(f.bots[0].id, api.createSession([f.bots[0].id]).id, 'queued before crash', 'queued', extra)
    const running = await api.createTaskRecordDurable(f.bots[0].id, api.createSession([f.bots[0].id]).id, 'running before crash', 'running', extra)
    api.setTaskStatus(running.id, 'running'); await api.flushAll()
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      globalThis.__taskPool={events:[],send:()=>{throw Error('Recovery must not run work')}};
      const api=await import(${JSON.stringify(pathToFileURL(f.module).href)});
      await api.loadSessions();await api.loadTasks();await api.flushAll();
      console.log(JSON.stringify(api.listTasks().map(t=>({id:t.id,status:t.status,deliveryStatus:t.deliveryStatus}))));
    `], { env: { ...process.env, OPENBOT_DATA_DIR: f.root }, encoding: 'utf8', timeout: 10000 })
    assert.equal(child.status, 0, child.stderr)
    const recovered = JSON.parse(child.stdout.trim())
    for (const task of [queued, running]) {
      assert.equal(recovered.find(t => t.id === task.id).status, 'failed')
      assert.equal(recovered.find(t => t.id === task.id).deliveryStatus, 'uncertain')
      const journal=JSON.parse(await readFile(join(f.root,'task-recovery.json'),'utf8'))
      assert.equal(journal.entries[task.id].kind,'execution')
    }
    assert.equal(f.state.calls.length, 0)
  } finally { await f.close() }
})

test('production policy admits 1000 simultaneous waiting requests independently of four live execution slots', async () => {
  const f=await fixture(true), {api,state}=f
  try {
    assert.equal(api.MAX_CONCURRENT_RUNS,4)
    assert.equal(api.MAX_QUEUED_TASKS_PER_BOT,10000)
    assert.equal(api.MAX_QUEUED_TASKS,50000)
    const active=await Promise.all(Array.from({length:4},()=>f.create()))
    await until(()=>state.active===4)
    const started=performance.now(), heapBefore=process.memoryUsage().heapUsed
    const queued=await Promise.all(Array.from({length:1000},(_,i)=>f.create(f.bots[0],`Isolated large queue request ${i}.`)))
    assert.equal(api.countQueuedTasks(),1000)
    assert.equal(api.countActiveTasks(),1004)
    assert.equal(api.countQueuedTasks(f.bots[0].id),1000)
    assert.equal(state.calls.length,4)
    assert.equal(api.listTasks().filter(t=>t.status==='queued').length,1000)
    const admissionMs=performance.now()-started, heapDelta=process.memoryUsage().heapUsed-heapBefore
    f.release(active[0]);await until(()=>state.calls.length===5)
    assert.equal(api.countQueuedTasks(),999)
    assert.equal(state.calls[4].id,queued[0].sessionId)
    assert.equal(state.maximum,4)
    console.log(JSON.stringify({benchmark:'actual 1000 admissions with SQLite sessions and atomic task JSON',admissionMs,heapDeltaBytes:heapDelta,maxRunning:state.maximum,waiting:1000}))
  } finally {await f.close()}
})

test('50000 persisted queued records recover through one atomic journal without execution', async () => {
  const root=await mkdtemp(join(tmpdir(),'blinky-queue-50000-')),folder=join(root,'tasks'),module=join(root,'runtime.mjs')
  try {
    await mkdir(folder)
    await writeFile(module,productionBundle.outputFiles[0].contents)
    let next=0
    const total=50000, seeded=performance.now()
    await Promise.all(Array.from({length:16},async()=>{
      for(;;){const i=next++;if(i>=total)return
        const task={id:`scale-${i}`,botId:`bot-${Math.floor(i/10000)}`,sessionId:`private-${i}`,sourceSessionId:'home',title:'Scale fixture',prompt:'A short isolated queued request; no provider is called.',status:'queued',createdAt:1700000000000+i,updatedAt:1700000000000+i,executionAgent:{backendId:'fixture',modelId:'fixture'}}
        await writeFile(join(folder,task.id+'.json'),JSON.stringify(task))
      }
    }))
    const child=spawnSync(process.execPath,['--input-type=module','-e',`
      globalThis.__taskPool={events:[],send:()=>{throw Error('No execution permitted')}};
      const api=await import(${JSON.stringify(pathToFileURL(module).href)});const at=performance.now();
      await api.loadTasks();await api.flushAll();const records=api.listTasks();
      console.log(JSON.stringify({benchmark:'50000 JSON records, actual store recovery',count:records.length,allUncertain:records.every(t=>t.status==='failed'&&t.deliveryStatus==='uncertain'),queued:api.countQueuedTasks(),active:api.countActiveTasks(),recoveryMs:performance.now()-at,rssBytes:process.memoryUsage().rss}));
    `],{env:{...process.env,OPENBOT_DATA_DIR:root},encoding:'utf8',timeout:180000,maxBuffer:1024*1024})
    assert.equal(child.status,0,child.stderr)
    const result=JSON.parse(child.stdout.trim())
    assert.equal(result.count,total);assert.equal(result.allUncertain,true);assert.equal(result.queued,0);assert.equal(result.active,0)
    console.log(JSON.stringify({...result,totalFixtureMs:performance.now()-seeded}))
    assert.equal(JSON.parse(await readFile(join(root,'task-recovery.json'),'utf8')).entries['scale-49999'].kind,'execution')
  } finally {await rm(root,{recursive:true,force:true})}
})

test('recovery journal is repeatable, preserves original files, and yields to a newer durable task update',async()=>{
 const root=await mkdtemp(join(tmpdir(),'blinky-task-journal-')),module=join(root,'runtime.mjs'),folder=join(root,'tasks')
 try{
  await mkdir(folder);await writeFile(module,productionBundle.outputFiles[0].contents)
  const task={id:'journal-task',botId:'bot',sessionId:'private',sourceSessionId:'home',status:'queued',title:'Journal fixture',prompt:'Original objective retained.',createdAt:1,updatedAt:1}
  const raw=JSON.stringify(task);await writeFile(join(folder,task.id+'.json'),raw)
  const run=code=>{
   const child=spawnSync(process.execPath,['--input-type=module','-e',`globalThis.__taskPool={events:[],send:()=>{throw Error('No replay')}};const api=await import(${JSON.stringify(pathToFileURL(module).href)});await api.loadTasks();${code}`],{env:{...process.env,OPENBOT_DATA_DIR:root},encoding:'utf8',timeout:10000})
   assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout.trim())
  }
  const first=run(`await api.loadTasks();console.log(JSON.stringify(api.getTask('journal-task')))`)
  assert.equal(first.status,'failed');assert.equal(first.deliveryStatus,'uncertain')
  assert.equal(await readFile(join(folder,task.id+'.json'),'utf8'),raw)
  const second=run(`console.log(JSON.stringify(api.getTask('journal-task')))`)
  assert.equal(second.updatedAt,first.updatedAt)
  assert.equal((await readFile(join(root,'task-recovery.json'),'utf8')).includes(task.prompt),false)
  run(`await api.storeTaskReviewDurable('journal-task',{outcome:'blocked',summary:'Checked later',evidence:[],recordedAt:2});api.updateTaskDelivery('journal-task','delivered');await api.flushAll();console.log('true')`)
  const updated=run(`console.log(JSON.stringify(api.getTask('journal-task')))`)
  assert.equal(updated.review.summary,'Checked later');assert.equal(updated.deliveryStatus,'delivered')
  assert.deepEqual(JSON.parse(await readFile(join(root,'task-recovery.json'),'utf8')).entries,{})
 }finally{await rm(root,{recursive:true,force:true})}
})

test('invalid recovery metadata fails closed without rewriting the original task',async()=>{
 const root=await mkdtemp(join(tmpdir(),'blinky-task-journal-invalid-')),module=join(root,'runtime.mjs'),folder=join(root,'tasks')
 try{
  await mkdir(folder);await writeFile(module,productionBundle.outputFiles[0].contents)
  const raw=JSON.stringify({id:'task',botId:'bot',sessionId:'private',status:'queued',prompt:'Keep original',createdAt:1,updatedAt:1})
  await writeFile(join(folder,'task.json'),raw)
  const bad=JSON.stringify({version:1,entries:{task:{base:'invalid',at:1,kind:'execution'}}})
  await writeFile(join(root,'task-recovery.json'),bad)
  const child=spawnSync(process.execPath,['--input-type=module','-e',`globalThis.__taskPool={events:[]};const api=await import(${JSON.stringify(pathToFileURL(module).href)});let refused=false;try{await api.loadTasks()}catch{refused=true}console.log(JSON.stringify({refused,status:api.getTask('task').status}))`],{env:{...process.env,OPENBOT_DATA_DIR:root},encoding:'utf8',timeout:10000})
  assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout.trim()),{refused:true,status:'queued'})
  assert.equal(await readFile(join(folder,'task.json'),'utf8'),raw)
  assert.equal(await readFile(join(root,'task-recovery.json'),'utf8'),bad)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('restart retains interrupted tasks for Bot review without appending host templates',async()=>{
 const root=await mkdtemp(join(tmpdir(),'blinky-task-recovery-notice-')),module=join(root,'runtime.mjs')
 try{
  await writeFile(module,productionBundle.outputFiles[0].contents)
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
   globalThis.__taskPool={events:[],send:()=>{throw Error('No replay')}};const api=await import(${JSON.stringify(pathToFileURL(module).href)});await api.loadBots();await api.loadSessions();
   const bot=api.createBot({name:'Recovery source',backendId:'fixture',modelId:'fixture'}),other=api.createBot({name:'Other source',backendId:'fixture',modelId:'fixture'}),home=api.ensureBotHome(bot.id);api.saveSession({...home,botIds:[bot.id,other.id],mode:'agent',cwd:process.env.OPENBOT_DATA_DIR});
   const {mkdir,writeFile}=await import('node:fs/promises'),{join}=await import('node:path');await mkdir(join(process.env.OPENBOT_DATA_DIR,'tasks'),{recursive:true});
   for(let i=0;i<66;i++)await writeFile(join(process.env.OPENBOT_DATA_DIR,'tasks','notice-'+i+'.json'),JSON.stringify({id:'notice-'+i,botId:i<64?bot.id:other.id,sessionId:'private-'+i,sourceSessionId:home.id,status:'queued',prompt:'Local fixture',createdAt:1,updatedAt:1}));
   await api.loadTasks();api.installTaskInbox();for(let i=0;i<200&&api.getSession(home.id).messages.length<2;i++)await new Promise(r=>setTimeout(r,5));await api.flushAll();
   const messages=api.getSession(home.id).messages;console.log(JSON.stringify({notices:messages.filter(m=>m.content.includes('64')&&m.botId===bot.id).length,other:messages.filter(m=>m.content.includes('2 个')&&m.botId===other.id).length,total:messages.length,active:api.countActiveTasks()}));
  `],{env:{...process.env,OPENBOT_DATA_DIR:root},encoding:'utf8',timeout:15000})
  assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout.trim()),{notices:0,other:0,total:0,active:0})
 }finally{await rm(root,{recursive:true,force:true})}
})
