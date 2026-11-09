import {test} from 'node:test'
import assert from 'node:assert/strict'
import {defineTool,ok} from './results.ts'
import {setExecutionAgent,clearExecutionAgent,revokeExecutorAccess} from '../agent/executionAgent.ts'
import {noteLocalPermissionSettings} from '../localExecution.ts'

test('local MCP tools use the independent executor grant, retain hard denials and cancel on revocation',{timeout:2000},async()=>{
 const settings={localExecutionPolicy:'always-allow' as const,approvalPolicy:'auto-run' as const,automaticReview:false,allowlist:[],asklist:[],denylist:[],semanticPermissionRules:[]}
 let calls=0,approvals=0
 const ctx:any={sessionId:'full',botId:'owner',signal:new AbortController().signal,settings,requestApproval:async()=>{approvals++;return true}}
 const tool=defineTool({name:'read_file',description:'Synthetic',parameters:{type:'object',properties:{}},mutating:false},async(_args,c)=>{calls++;assert.equal(c.settings?.automaticReview,true);return ok(c,'read_file','fixture')})
 setExecutionAgent('full',{backendId:'kimi',modelId:'fixture',accessMode:'full-access'},'owner')
 try {
  assert.equal((await tool.handler({path:'fixture'},ctx)).ok,true);assert.equal(approvals,0)
  assert.equal((await tool.handler({path:'fixture'},{...ctx,settings:{...settings,denylist:['*']}})).ok,false);assert.equal(calls,1)
  const waiting=defineTool({name:'read_file',description:'Synthetic',parameters:{type:'object',properties:{}},mutating:false},async(_args,c)=>{
   noteLocalPermissionSettings({...settings,automaticReview:true});assert.equal(c.signal.aborted,false)
   revokeExecutorAccess('owner');assert.equal(c.signal.aborted,true);return ok(c,'read_file','stopped fixture')
  })
  assert.equal((await waiting.handler({path:'fixture'},ctx)).ok,false)
 }finally{clearExecutionAgent('full')}
})
