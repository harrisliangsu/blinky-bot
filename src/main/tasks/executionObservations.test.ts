import assert from'node:assert/strict'
import{test}from'node:test'
import{executionObservations}from'./executionObservations'
import type{Message}from'../../shared/types'
const message=(id:string):Message=>({id,role:'assistant',content:'',createdAt:1})
test('native cumulative input and final receipt expose actual tool/path/state without file bodies or credentials',()=>{
 const m=message('one');m.agentTrace=[{id:'read',kind:'read',phase:'started',detail:'{}'},{id:'read',kind:'kimi_tool',phase:'started',detail:JSON.stringify({content:[{content:{text:JSON.stringify({path:'/tmp/fixture.txt',limit:10})}}]})},{id:'read',kind:'kimi_tool',phase:'completed',detail:JSON.stringify({status:'completed',content:[{content:{text:'PRIVATE_FILE_BODY function secret() {}'}}]})},{id:'read',kind:'kimi_tool',phase:'started',detail:'{}'}]
 const rows=executionObservations([m]);assert.equal(rows.length,1);assert.equal(rows[0]?.tool,'read');assert.equal(rows[0]?.target,'/tmp/fixture.txt');assert.equal(rows[0]?.state,'completed');assert.equal(rows[0]?.outputPresent,true);assert.equal(/PRIVATE_FILE_BODY|secret\(|DO_NOT_EXPOSE/.test(JSON.stringify(rows)),false)
})
test('different messages with reused native call IDs stay separate; started/failed do not become success',()=>{
 const a=message('a'),b=message('b');a.agentTrace=[{id:'same',kind:'read',phase:'started',detail:'{}'}];b.agentTrace=[{id:'same',kind:'read',phase:'completed',detail:JSON.stringify({status:'failed'})}]
 assert.deepEqual(executionObservations([a,b]).map(r=>r.state),['started','failed']);assert.notEqual(executionObservations([a,b])[0]?.messageId,executionObservations([a,b])[1]?.messageId)
})
test('oversized or malformed trace stays metadata only; hidden messages and raw tool outputs are omitted',()=>{
 const a=message('a');a.agentTrace=[{id:'one',kind:'read',phase:'completed',detail:'x'.repeat(17000)}];const hidden={...message('hidden'),internal:true,agentTrace:a.agentTrace};const tool:Message={id:'result',role:'tool',content:'private',createdAt:1,toolResult:{callId:'call',name:'read_file',ok:true,output:'PRIVATE_BODY'}}
 const rows=executionObservations([hidden,a,tool]);assert.equal(rows.length,2);assert.equal(JSON.stringify(rows).includes('PRIVATE_BODY'),false);assert.equal(rows[0]?.state,'unconfirmed')
})
test('a completed JSON file body is never mistaken for tool input or execution state',()=>{
 const m=message('json');m.agentTrace=[{id:'read',kind:'read',phase:'started',detail:'{}'},{id:'read',kind:'kimi_tool',phase:'completed',detail:JSON.stringify({status:'completed',content:[{content:{text:JSON.stringify({path:'/private/DO_NOT_INFER',status:'failed',password:'DO_NOT_EXPOSE'})}}]})}]
 const rows=executionObservations([m]);assert.equal(rows[0]?.state,'completed');assert.equal(rows[0]?.target,undefined);assert.equal(JSON.stringify(rows).includes('DO_NOT'),false)
})
test('input fields cannot promote a started call to completed',()=>{
 const m=message('input');m.agentTrace=[{id:'read',kind:'read',phase:'started',detail:JSON.stringify({status:'completed',rawInput:{path:'/tmp/input'}})}]
 assert.equal(executionObservations([m])[0]?.state,'started')
})
