import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

test('a manual run before a future once occurrence does not unregister background execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-once-launcher-'))
  const oldSmoke = process.env.BLINKY_SMOKE, oldData = process.env.OPENBOT_DATA_DIR
  delete process.env.BLINKY_SMOKE; delete process.env.OPENBOT_DATA_DIR
  const at = Date.now() + 3_600_000
  globalThis.__onceLauncher = { root, routine: { id: 'once', trigger: { kind: 'once', at }, lastRunAt: at - 1_800_000, lastRunState: 'finished' }, runs: [], enabled: [] }
  const mocks = {
    electron: 'export const app={isPackaged:true,getPath:name=>name==="userData"?globalThis.__onceLauncher.root:"/fixture/BlinkyBot.app/Contents/MacOS/BlinkyBot"}',
    '../settings': 'export const getSettings=()=>({runRoutinesWhenClosed:true});export const onSettingsChanged=()=>{};export const settingsAreUnreadable=()=>false',
    '../store/paths': 'export const dataRoot=()=>globalThis.__onceLauncher.root',
    '../store/routines': 'export const listRoutines=()=>[globalThis.__onceLauncher.routine];export const routinesLoadWasIncomplete=()=>false',
    '../ipc/broadcast': 'export const postActivity=()=>{throw Error("Unexpected launcher failure")}',
    '../store/activity': 'export const listActivity=()=>[]',
    '../connectors/slackSecrets': 'export const readSlackCredentials=async()=>null',
    '../routines/runs': 'export const listRoutineRuns=async()=>globalThis.__onceLauncher.runs',
    './routineLaunchJob': 'export const reconcileRoutineJob=async o=>{globalThis.__onceLauncher.enabled.push(o.enabled);return{state:o.enabled?"active":"inactive"}}'
  }
  let api
  try {
    await build({ stdin: { contents: `export * from './routineLauncher.ts'`, resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: join(root, 'launcher.mjs'), plugins: [{ name: 'no-real-launchd', setup(b) {
      b.onResolve({ filter: /.*/ }, a => Object.hasOwn(mocks, a.path) ? { path: a.path, namespace: 'mock' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'mock' }, a => ({ contents: mocks[a.path], loader: 'js' }))
    } }] })
    api = await import(pathToFileURL(join(root, 'launcher.mjs')).href)
    api.installRoutineLauncher(); await api.syncRoutineLauncher()
    assert.equal(globalThis.__onceLauncher.enabled.at(-1), true)
    globalThis.__onceLauncher.routine.lastRunAt = at
    globalThis.__onceLauncher.runs = [{ scheduledAt: at, status: 'finished' }]
    await api.syncRoutineLauncher()
    assert.equal(globalThis.__onceLauncher.enabled.at(-1), false)
    globalThis.__onceLauncher.routine.lastRunAt = at + 1_800_000
    await api.syncRoutineLauncher()
    assert.equal(globalThis.__onceLauncher.enabled.at(-1), false)
    globalThis.__onceLauncher.routine.lastRunState = 'failed'
    await api.syncRoutineLauncher()
    assert.equal(globalThis.__onceLauncher.enabled.at(-1), false)
    globalThis.__onceLauncher.routine.trigger.at = at + 7_200_000
    await api.syncRoutineLauncher()
    assert.equal(globalThis.__onceLauncher.enabled.at(-1), true)
  } finally {
    api?.stopRoutineLauncher()
    if (oldSmoke === undefined) delete process.env.BLINKY_SMOKE; else process.env.BLINKY_SMOKE = oldSmoke
    if (oldData === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = oldData
    await rm(root, { recursive: true, force: true })
  }
})
