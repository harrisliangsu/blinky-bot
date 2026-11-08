import assert from 'node:assert/strict'
import {test} from 'node:test'
import {build} from 'esbuild'
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
test('protected judgment persists decisions, rejects repeat consent and isolates tasks; crash state is not replayed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'blinky-protected-judgment-')),before=process.env.OPENBOT_DATA_DIR;process.env.OPENBOT_DATA_DIR=root
 const state=globalThis.__protectedJudgment={calls:[],answer:{state:'ready',text:'{"kind":"silent"}'}};const outfile=join(root,'test.mjs')
 try{
  await build({stdin:{contents:`export * from './progressTurn.ts'`,resolveDir:join(process.cwd(),'src/main/tasks'),loader:'ts'},outfile,bundle:true,platform:'node',format:'esm',external:['electron'],plugins:[{name:'safe-judgment-test',setup(b){b.onResolve({filter:/taskJudgmentTurn$/},()=>({path:'turn',namespace:'mock'}));b.onResolve({filter:/vaultPrivacy$/},()=>({path:'privacy',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:a.path==='privacy'?'export const scrubVaultTranscript=t=>t':`export async function runTaskJudgmentTurn(i){const s=globalThis.__protectedJudgment;s.calls.push(i);if(s.gate)await s.gate;return s.answer}`,loader:'js'}))}}]})
  const api=await import(pathToFileURL(outfile).href),signal=new AbortController().signal,s={id:'one',owner:'["home","bot","execution"]',title:'Synthetic',phase:'running',progress:'p',detail:'',terminal:false,needsAttention:false,evidence:[{id:'e',kind:'report',text:'observed'}]},input={sessionId:'home',botId:'bot',prompt:'only synthetic observations',permissions:'a',signal}
  assert.equal((await api.protectedProgressDecision(s,input)).kind,'silent');assert.equal((await api.protectedProgressDecision(s,input)).kind,'silent');assert.equal(state.calls.length,1)
  state.answer={state:'denied'};assert.equal(await api.protectedProgressDecision(s,{...input,prompt:'new report'}),null);assert.equal((await api.taskJudgmentStatus('one')).state,'denied');const denied=state.calls.length
  assert.equal(await api.protectedProgressDecision(s,{...input,prompt:'another Agent report is not consent'}),null);assert.equal(state.calls.length,denied)
  state.answer={state:'ready',text:'{"kind":"milestone","text":"合成阶段已完成，可以继续核对。","evidenceIds":["e"]}'};assert.equal((await api.protectedProgressDecision(s,{...input,prompt:'new report',permissions:'explicitly-changed'})).kind,'milestone')
  const status=await api.taskJudgmentStatus('one');await writeFile(join(root,'task-judgments','one.json'),JSON.stringify({...status,state:'prepared',decision:undefined}));const count=state.calls.length
  assert.equal(await api.protectedProgressDecision(s,{...input,prompt:'new report',permissions:'explicitly-changed'}),null);assert.equal(state.calls.length,count);assert.equal((await api.taskJudgmentStatus('one')).state,'uncertain')
  assert.equal(await api.protectedProgressDecision(s,{...input,prompt:'new report',permissions:'explicitly-changed'}),null);assert.equal(state.calls.length,count)
  assert.equal(await api.protectedProgressDecision({...s,owner:'["another-source","bot","execution"]'},input),null);assert.equal(state.calls.length,count)
  let release;state.gate=new Promise(r=>release=r);state.answer={state:'ready',text:'{"kind":"silent"}'};const another={...s,id:'two'};const a=api.protectedProgressDecision(another,input),b=api.protectedProgressDecision(another,input);await new Promise(r=>setTimeout(r,20));release();assert.equal((await a).kind,'silent');assert.equal((await b).kind,'silent');assert.equal(state.calls.filter(c=>c.taskId==='two').length,1)
  state.gate=null;state.answer={state:'failed'};assert.equal(await api.protectedProgressDecision({...s,id:'failed'},input),null);const failures=state.calls.length;assert.equal(await api.protectedProgressDecision({...s,id:'failed'},input),null);assert.equal(state.calls.length,failures)
  const stored=await readFile(join(root,'task-judgments','failed.json'),'utf8');assert.equal(stored.includes(input.prompt),false)
 }finally{if(before===undefined)delete process.env.OPENBOT_DATA_DIR;else process.env.OPENBOT_DATA_DIR=before;delete globalThis.__protectedJudgment;await rm(root,{recursive:true,force:true})}
})
