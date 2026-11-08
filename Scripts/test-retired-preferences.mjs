import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const root=await mkdtemp(join(tmpdir(),'blinky-retired-preferences-'))
process.env.OPENBOT_DATA_DIR=root
const file=join(root,'outbound-send-rules.json');await writeFile(file,'legacy-encrypted-sentinel')
const out=join(root,'test.mjs')
await build({stdin:{contents:`export {quickDecisionHint} from './src/main/agent/quickDecision.ts';export {withMatchingGmailSendRule,sendRuleStillApplies} from './src/main/connectors/sendRules.ts'`,resolveDir:resolve('.'),loader:'ts'},outfile:out,bundle:true,platform:'node',format:'esm',plugins:[{name:'no-external-effect',setup(b){b.onResolve({filter:/backendGateway|vaultPrivacy|agent\/events/},a=>({path:a.path,namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},a=>({contents:a.path.includes('backendGateway')?`export const getBackend=()=>{throw Error('hidden side call')};export const runSideCall=getBackend`:a.path.includes('vaultPrivacy')?`export const scrubVaultJson=x=>x;export const scrubVaultTranscript=x=>x`:`export const broadcast=()=>{throw Error('Unexpected broadcast')}`}))}}]})
const api=await import(out)
assert.equal(await api.quickDecisionHint({settings:{quickDecision:null},request:'synthetic',signal:new AbortController().signal,cwd:root}),null)
assert.equal(await api.withMatchingGmailSendRule('synthetic@example.test','other@example.test',()=>{throw Error('automatic claim')}),undefined)
assert.equal(api.sendRuleStillApplies({enabled:true,id:'saved'}),false)
assert.equal(await readFile(file,'utf8'),'legacy-encrypted-sentinel')
console.log('PASS: disabled optional advice starts no model call; legacy send rules are unread and unchanged; no automatic claim; prior grant refused')
