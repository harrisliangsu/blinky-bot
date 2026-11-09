import assert from 'node:assert/strict'
import { test } from 'node:test'
import { answerAcpForm, answerAcpQuestion } from './acpQuestions.ts'
import { supportsFullAccessExecution } from '../../../shared/executionAccess.ts'
import { buildArgs } from './claude.ts'
const form={mode:'form',message:'Synthetic details',requestedSchema:{properties:{q0:{type:'string',title:'Format',oneOf:[{const:'A'},{const:'B'}]},q1:{type:'array',title:'Parts',items:{anyOf:[{const:'X'},{const:'Y'}]}}}}}
test('native ACP questions preserve all fields and multiselect; cancellation, out-of-scope and unrecognized values never become approval',async()=>{
 assert.deepEqual(await answerAcpForm(form,()=>true,async q=>{assert.equal(q.length,2);return {q0:['A'],q1:['X','Y']}}),{action:'accept',content:{q0:'A',q1:['X','Y']}})
 for (const get of [async()=>null,async()=>({q0:['other'],q1:['X']}),async()=>{throw Error('cancelled')}]) assert.deepEqual(await answerAcpForm(form,()=>true,get),{action:'cancel'})
 assert.deepEqual(await answerAcpForm(form,()=>false,async()=>{throw Error('should not ask')}),{action:'cancel'})
 assert.deepEqual(await answerAcpForm({...form,mode:'url'},()=>true,async()=>null),{action:'cancel'})
 const q={toolCall:{title:'AskUserQuestion'},options:[{kind:'allow_once',optionId:'opaque',name:'A'}]}
 assert.deepEqual(await answerAcpQuestion(q,()=>true,async()=>({question:['A']})),{outcome:{outcome:'selected',optionId:'opaque'}})
 assert.deepEqual(await answerAcpQuestion(q,()=>true,async()=>null),{outcome:{outcome:'cancelled'}})
})
test('supported profiles are explicit, Claude enables native tools only for the executor and rejects role or extra-argument escalation',()=>{
 for(const id of ['codex','kimi','claude','grok'])assert.equal(supportsFullAccessExecution(id),true)
 for(const id of ['pi','opencode','droid','custom'])assert.equal(supportsFullAccessExecution(id),false)
 const req={model:'m',messages:[],signal:new AbortController().signal,executionAccess:'full-access' as const}
 const args=buildArgs(req,'default','',[],[],[])
 assert.equal(args[args.indexOf('--permission-mode')+1],'bypassPermissions');assert.equal(args[args.indexOf('--tools')+1],'default')
 assert.equal(args[args.indexOf('--disallowedTools')+1],'AskUserQuestion')
 assert.throws(()=>buildArgs({...req,readOnly:true},'default','',[],[],[]),/role cannot/)
 assert.throws(()=>buildArgs(req,'default','',['--permission-mode','auto'],[],[]),/cannot override/)
 const old=buildArgs({...req,executionAccess:undefined},'default','',[],[],[])
 assert.equal(old[old.indexOf('--permission-mode')+1],'manual');assert.ok(old.includes('Read,Glob,Grep,WebFetch,WebSearch'))
})
