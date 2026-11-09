import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

let fixture
const output = await build({ entryPoints: [fileURLToPath(new URL('./quickDecision.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'only-inference-and-vault-boundaries', setup(b) {
  b.onResolve({ filter: /^\.\/backendGateway$/ }, () => ({ path: 'backend', namespace: 'fixture' }))
  b.onResolve({ filter: /^\.\.\/store\/vaultPrivacy$/ }, () => ({ path: 'vault', namespace: 'fixture' }))
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'backend'
    ? 'export const getBackend=(...args)=>globalThis.__quickDecisionFixture.getBackend(...args); export const runSideCall=(...args)=>globalThis.__quickDecisionFixture.runSideCall(...args)'
    : 'export const scrubVaultJson=v=>JSON.parse(JSON.stringify(v).replaceAll("fixture-private","[redacted]")); export const scrubVaultTranscript=v=>v.replaceAll("fixture-private","[redacted]")', loader: 'js' }))
} }] })
const api = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'))
function reset(kind = 'cloud-api', id = 'fixture-api') {
  fixture = globalThis.__quickDecisionFixture = { calls: [], lookups: [], result: { text: '{"route":"delegate","reason":"Several steps"}', calls: [] }, getBackend: async id => { fixture.lookups.push(id); return { id, kind } }, runSideCall: async (...args) => { fixture.calls.push(args); return fixture.result } }
  return { settings: { backends: { [id]: { enabled: true } }, quickDecision: { backendId: id, modelId: 'routing-model' }, defaultModelId: 'lead-model' }, request: 'Do the work', context: [{ role: 'user', text: 'Prior settled context' }], cwd: '/fixture', signal: new AbortController().signal }
}


// The legacy preference is retained only for storage compatibility. Even an
// explicitly configured value must not introduce another model or tool loop.
test('retired quickDecision never looks up or calls a backend, including configured legacy values',async()=>{
 for(const [kind,id] of [['cloud-api','api'],['local-server','local'],['agent-cli','pi'],['agent-cli','codex']]){
  const input=reset(kind,id),before=JSON.stringify(input)
  assert.equal(await api.quickDecisionHint(input),null)
  assert.deepEqual(fixture.lookups,[]);assert.deepEqual(fixture.calls,[]);assert.equal(JSON.stringify(input),before)
 }
})
test('absent, disabled and cancelled legacy routing stays inert and does not expose chat context',async()=>{
 for(const mode of ['absent','null','disabled','cancelled']){
  const input=reset();input.request='fixture-private';input.context=[{role:'user',text:'private prior goal'}]
  if(mode==='absent')delete input.settings.quickDecision
  if(mode==='null')input.settings.quickDecision=null
  if(mode==='disabled')input.settings.backends['fixture-api'].enabled=false
  if(mode==='cancelled'){const controller=new AbortController();controller.abort();input.signal=controller.signal}
  assert.equal(await api.quickDecisionHint(input),null);assert.deepEqual(fixture.lookups,[]);assert.deepEqual(fixture.calls,[])
 }
})
