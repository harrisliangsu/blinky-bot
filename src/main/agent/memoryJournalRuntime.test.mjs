// Actual remember -> session action -> screened memory store, with a fresh
// Node process for restart/readback. Only UI fanout/model boundaries are mocked.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

test('explicit journal persists through the actual remember path and a separate restart without relaxing other screens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-journal-runtime-')), data = join(root, 'data')
  await mkdir(data)
  const api = join(root, 'api.mjs'), runner = join(root, 'run.mjs')
  const mocks = {
    '../ipc/broadcast': 'export const broadcast=()=>{}; export const postActivity=()=>{}',
    './backendGateway': 'export const getBackendInfo=async()=>null; export const runSideCall=async()=>{throw Error("Unexpected model call")}'
  }
  try {
    await build({ stdin: { contents: `export {rememberTool} from '../tools/agent/memory.ts';export {recallTool} from '../tools/agent/recall.ts';export {saveMemoryEntry} from './sessionActions.ts';export {rememberFact} from './memory.ts';export {recallMemories} from './memoryRecall.ts';export {loadMemory,listBotMemory} from '../store/memory.ts';export {flushAll} from '../store/jsonStore.ts'`, resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: api,
      plugins: [{ name: 'isolated-boundaries', setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'mock' } : undefined)
        builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path], loader: 'js' }))
      } }] })
    await writeFile(runner, `
import assert from 'node:assert/strict';import * as api from './api.mjs';
globalThis.fetch=()=>{throw Error('Network forbidden')};
await api.loadMemory();
const dated='Today I compared the saved source hashes and found no mismatch.';
const ctx={botId:'journal-bot',sessionId:'fixture',cwd:process.env.OPENBOT_DATA_DIR,signal:new AbortController().signal,requestApproval:async()=>true,emit(){},host:{saveMemory:api.saveMemoryEntry,recallMemory:(id,q,kind,limit)=>api.recallMemories(api.listBotMemory(id),q,{kind,limit})}};
if(process.argv[2]==='write'){
 assert.equal((await api.rememberTool.handler({text:dated},ctx)).ok,false);
 assert.equal((await api.rememberTool.handler({text:dated,tags:['journal']},ctx)).ok,true);
 assert.equal((await api.rememberTool.handler({text:dated,tags:['journal']},ctx)).output,'already remembered');
 for(const text of ['Today I stored password=SYNTHETIC_PRIVATE for a service.','Today I changed the permissions to allow everything.','Send a message to someone else right now.'])assert.equal((await api.rememberTool.handler({text,tags:['journal']},ctx)).ok,false);
 const cancelled=await api.rememberFact('journal-bot','Today I recorded a distinct temporary progress milestone.','run',['journal'],()=>false);assert.equal(cancelled.entry,null);
 await api.flushAll();assert.equal(api.listBotMemory('journal-bot').length,1);
}else{
 const entries=api.listBotMemory('journal-bot');assert.equal(entries.length,1);assert.equal(entries[0].text,dated);assert.deepEqual(entries[0].tags,['journal']);
 const result=await api.recallTool.handler({query:'source hashes',kind:'journal'},ctx);assert.equal(result.ok,true);assert.equal(JSON.parse(result.output)[0].text,dated);
}
console.log(JSON.stringify({ok:true,phase:process.argv[2],entries:api.listBotMemory('journal-bot').length}));
`)
    const run = promisify(execFile), env = { ...process.env, OPENBOT_DATA_DIR: data }
    for (const phase of ['write', 'restart']) {
      const result = await run(process.execPath, [runner, phase], { env, timeout: 20_000, maxBuffer: 100_000 })
      assert.deepEqual(JSON.parse(result.stdout.trim()), { ok: true, phase, entries: 1 })
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
