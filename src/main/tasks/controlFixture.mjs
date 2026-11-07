import { build } from 'esbuild'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error('The expected local boundary was not reached')
}

export async function fixture({ clarificationSource } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'blinky-task-control-')), previous = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  const state = { calls: [], events: [], gates: new Map(), steering: [], sideCalls: [], answer: null, stopped: [] }
  globalThis.__taskControl = state
  const mocks = {
    './ipc/broadcast': 'export const broadcast=e=>globalThis.__taskControl.events.push(e);export const postActivity=()=>{}',
    '../ipc/broadcast': 'export const broadcast=e=>globalThis.__taskControl.events.push(e);export const postActivity=()=>{}',
    './ipc/agentRuntime': 'export const loopFn=async n=>n==="sendMessage"?globalThis.__taskControl.send:n==="stopSession"?async id=>globalThis.__taskControl.stopped.push(id):async()=>false',
    './agent/messageQueueRuntime': 'export const isQueueDraining=()=>false;export const isQueueSuspended=()=>false;export const queueSuspensionGeneration=id=>globalThis.__taskControl.generations?.[id]??globalThis.__taskControl.generation??0',
    // Keep the synthetic lead busy: these tests inspect the result directly,
    // rather than starting an unbounded automatic inbox-review retry loop.
    './agent/cancel': 'export const isRunning=id=>id===globalThis.__taskControl.homeId',
    './backends/cli/codexAppServer': 'export const steerCodexTurn=(...args)=>globalThis.__taskControl.steer(...args)',
    '../agent/backendGateway': 'export const runSideCall=async(...args)=>{globalThis.__taskControl.sideCalls.push(args);if(globalThis.__taskControl.sideCallError){args[3]?.(new Error(globalThis.__taskControl.sideCallError));return null}return globalThis.__taskControl.answer}'
  }
  const outfile = join(root, 'control.mjs')
  await build({ stdin: { contents: `export * from '../tasks.ts';export * from './messages.ts';export * from './progressRuntime.ts';export * from './progressObservations.ts';export * from './clarifications.ts';export * from '../store/tasks.ts';export * from '../store/sessions.ts';export * from '../store/bots.ts';export * from '../store/botHome.ts';export {manageTaskTool} from '../tools/agent/task.ts';export {flushAll,writeJsonNow} from '../store/jsonStore.ts';export {broadcast as event} from '../agent/events.ts';`, resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile,
    plugins: [{ name: 'safe-boundaries', setup(b) {
      b.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'mock' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path], loader: 'js' }))
      b.onLoad({ filter: /\/tasks\/clarifications\.ts$/ }, async args => {
        const source = await readFile(clarificationSource ?? args.path, 'utf8'), needle = '  await writeJsonNow(file(request.id), { runtimeId, request: safe })'
        if (!source.includes(needle)) throw new Error('Clarification persistence boundary changed.')
        return { contents: source.replace(needle, '  await globalThis.__taskControl.beforeClarificationWrite?.(safe)\n' + needle + '\n  await globalThis.__taskControl.afterClarificationWrite?.(safe)'), loader: 'ts' }
      })
      b.onLoad({ filter: /\/store\/tasks\.ts$/ }, async args => {
        const source = await readFile(args.path, 'utf8'), needle = '  await writeJsonNow(join(tasksDir(), `${safeFileName(task.id)}.json`), task)'
        if (!source.includes(needle)) throw new Error('The real durable task write boundary changed; update this barrier explicitly.')
        return { contents: source.replace(needle, '  await globalThis.__taskControl.beforeTaskRecordWrite?.(task)\n' + needle), loader: 'ts' }
      })
    } }] })
  const api = await import(pathToFileURL(outfile).href)
  await api.loadSessions(); await api.loadTasks()
  const bot = api.createBot({ name: 'Lead', backendId: 'codex', modelId: 'fixture', followsDefault: false })
  api.updateBot(bot.id, { executionAgent: { backendId: 'codex', modelId: 'worker' } })
  const home = api.ensureBotHome(bot.id)
  state.homeId = home.id
  api.saveSession({ ...home, mode: 'agent', cwd: root })
  function reply(id, text, extra = {}) {
    const session = api.getSession(id)
    api.saveSession({ ...session, messages: [...session.messages, { id: crypto.randomUUID(), role: 'assistant', content: text, createdAt: Date.now(), ...extra }] })
  }
  state.steer = async (id, text, record) => { state.steering.push({ id, text }); return false }
  state.send = async (id, text) => {
    state.calls.push({ id, text })
    if (!state.gates.has(id)) { let release; const promise = new Promise(resolve => { release = resolve }); state.gates.set(id, { promise, release }) }
    await state.gates.get(id).promise
    reply(id, `returned:${text}`)
  }
  async function start(text = 'original objective') { const task = await api.delegateBackgroundTask(home.id, bot.id, bot.id, text); await until(() => state.calls.some(value => value.id === task.sessionId)); return task }
  return { root, api, state, bot, home, start, reply, command: (command, sessionId = home.id, botId = bot.id, confirmResume) => api.manageBackgroundTask(sessionId, botId, command, new AbortController().signal, confirmResume), async close() {
    api.stopTaskProgressMonitor();
    for (const task of api.listTasks()) if (['queued', 'running'].includes(task.status)) await api.cancelBackgroundTask(task.id)
    for (const gate of state.gates.values()) gate.release()
    await new Promise(resolve => setTimeout(resolve, 40)); await api.flushAll()
    process.env.OPENBOT_DATA_DIR = previous; if (previous === undefined) delete process.env.OPENBOT_DATA_DIR
    await rm(root, { recursive: true, force: true })
  } }
}
