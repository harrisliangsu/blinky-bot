import assert from 'node:assert/strict'
import {test} from 'node:test'
import {beginTaskJudgment,taskJudgmentAllows,taskJudgmentScope,withoutTaskJudgmentDrafts,currentTaskJudgmentMessages,taskJudgmentInterruption} from './taskJudgmentScope'
test('task actions are classified explicitly, not by mutating:false; inspection keeps the current task scope',()=>{
 const release=beginTaskJudgment('source','owned-task','bot')
 try{
  for(const action of ['list','match'])assert.equal(taskJudgmentAllows('source','manage_task',{action}),true)
  assert.equal(taskJudgmentAllows('source','manage_task',{action:'inspect',task_id:'owned-task'}),true)
  assert.equal(taskJudgmentAllows('source','manage_task',{action:'inspect',task_id:'sibling'}),false)
  for(const action of ['message','stop','resume','report','prioritize','describe','unknown'])assert.equal(taskJudgmentAllows('source','manage_task',{action,task_id:'owned-task'}),false)
  for(const name of ['delegate_task','read_file','shell','handoff','remember','decision_review'])assert.equal(taskJudgmentAllows('source',name,{}),false)
  assert.equal(taskJudgmentScope('other'),undefined);assert.equal(taskJudgmentAllows('other','manage_task',{action:'message'}),true)
  assert.throws(()=>beginTaskJudgment('source','another','bot'))
 }finally{release();release()}
 assert.equal(taskJudgmentAllows('source','manage_task',{action:'message'}),true)
})
test('private considerations have one-use native conversations; only judgment drafts leave the human model history',()=>{
 const one=beginTaskJudgment('source','task','bot','attempt-one','observations one')
 const first=taskJudgmentScope('source')!.nativeSessionId
 assert.equal(taskJudgmentScope('source')!.prompt,'observations one');one()
 const two=beginTaskJudgment('source','task','bot','attempt-two','observations two')
 try{
  assert.notEqual(taskJudgmentScope('source')!.nativeSessionId,first)
  assert.deepEqual(currentTaskJudgmentMessages('source',[{id:'agent-judgment-attempt-one'},{id:'agent-judgment-draft-old'},{id:'agent-judgment-attempt-two'},{id:'agent-judgment-draft-current'},{id:'agent-judgment-tool-current'}]).map(m=>m.id),['agent-judgment-draft-current','agent-judgment-tool-current'])
 }finally{two()}
 const messages=[{id:'user',internal:false},{id:'agent-judgment-attempt-one',internal:true},{id:'agent-judgment-draft-answer',internal:true},{id:'agent-result-task',internal:true},{id:'approval-rejection',internal:true},{id:'agent-monitor-task-1',internal:false}]
 assert.deepEqual(withoutTaskJudgmentDrafts(messages).map(m=>m.id),['user','agent-result-task','approval-rejection','agent-monitor-task-1'])
})
test('human follow-up defers an interrupted consideration without inventing permission denial; real denial and unattended permission remain held',()=>{
 assert.equal(taskJudgmentInterruption({denied:false,permissionUnconfirmed:true},true,true),'deferred')
 assert.equal(taskJudgmentInterruption({denied:true,permissionUnconfirmed:true},true,true),'denied')
 assert.equal(taskJudgmentInterruption({denied:false,permissionUnconfirmed:true},true,false),'permission-required')
 assert.equal(taskJudgmentInterruption({denied:false,permissionUnconfirmed:false},true,false),'deferred')
 assert.equal(taskJudgmentInterruption({denied:false,permissionUnconfirmed:false},false,false),undefined)
})
