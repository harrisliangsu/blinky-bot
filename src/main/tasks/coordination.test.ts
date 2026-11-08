import assert from 'node:assert/strict'
import {test} from 'node:test'
import {TaskCoordinator,type CoordinationState,type CoordinationPorts,type CoordinationAction} from './coordination'
import type {ProgressSnapshot} from './progressMonitor'
function fixture(){
 let now=0,choice:CoordinationAction|null={kind:'ask',text:'目前哪些成果已经验证？有没有卡点或需要调整的方向？',nextCheckMinutes:10}
 const disk=new Map<string,CoordinationState>(),sent:{task:string,id:string,text:string,kind:string}[]=[],decisions:unknown[]=[],errors:unknown[]=[]
 const ports:CoordinationPorts={now:()=>now,read:async id=>structuredClone(disk.get(id)??null),write:async(id,s)=>{disk.set(id,structuredClone(s))},decide:async(s,c)=>{decisions.push(c);return choice},send:async(s,id,text,kind)=>{sent.push({task:s.id,id,text,kind});return 'queued'},error:(_id,e)=>errors.push(e)}
 const snapshot:ProgressSnapshot={id:'a',owner:'source/bot/executor',title:'photo chat',phase:'running',progress:'one',detail:'',terminal:false,needsAttention:true}
 return{ports,disk,sent,decisions,errors,snapshot,coordinator:new TaskCoordinator(ports),advance:(v:number)=>now+=v,choose:(v:CoordinationAction|null)=>choice=v}
}
test('withdrawn task-management permission is a known non-delivery, not an uncertain send or a reply to await',async()=>{
 const f=fixture(),o={snapshot:f.snapshot,replies:[]};await f.coordinator.observe(o)
 f.choose({kind:'advise',text:'先核对原合成输入。'});f.ports.send=async()=> 'not-permitted'
 await f.coordinator.observe({...o,report:'new-report'})
 assert.equal(f.disk.get('a')?.delivery,'not-permitted');assert.equal(f.disk.get('a')?.awaitingReply,undefined);assert.equal(f.disk.get('a')?.lastAdviceText,undefined)
 f.ports.send=async(s,id,text,kind)=>{f.sent.push({task:s.id,id,text,kind});return 'queued'}
 await f.coordinator.observe({...o,report:'explicit-permission-change-and-new-report'})
 assert.equal(f.sent.length,1)
})
test('low-interference periodic inquiry is one outstanding durable request, not an execution interrupt or a user report',async()=>{
 const f=fixture(),o={snapshot:f.snapshot,replies:[]};await f.coordinator.observe(o);assert.equal(f.sent.length,0)
 f.advance(10*60_000);await f.coordinator.observe(o);assert.equal(f.sent.length,1);assert.equal(f.sent[0]!.kind,'ask');assert.match(f.sent[0]!.text,/safe conversation boundary/)
 f.advance(60*60_000);await new TaskCoordinator(f.ports).observe(o);assert.equal(f.sent.length,1)
 assert.equal(f.disk.get('a')?.awaitingReply,f.sent[0]!.id)
})
test('correlated reply permits immediate concrete advice; delivery and response are distinct from adoption',async()=>{
 const f=fixture(),o={snapshot:f.snapshot,replies:[]};await f.coordinator.observe(o);f.advance(10*60_000);await f.coordinator.observe(o)
 const inquiry=f.sent[0]!.id;f.choose({kind:'advise',text:'先在隔离目录核对失败输入，再继续界面验证。',nextCheckMinutes:20})
 await f.coordinator.observe({...o,report:`reply:${inquiry}`,replies:[`reply:${inquiry}`],deliveries:{[inquiry]:'delivered'}})
 assert.equal(f.sent.length,2);assert.equal(f.sent[1]!.kind,'advise');assert.match(f.sent[1]!.text,/not new user consent/)
 assert.equal(f.disk.get('a')?.replyId,`reply:${inquiry}`);assert.equal(f.disk.get('a')?.delivery,'queued')
 await f.coordinator.observe({...o,report:`reply:${inquiry}`,replies:[`reply:${inquiry}`]});assert.equal(f.sent.length,2)
})
test('waiting/stopped/foreign tasks cannot be polled; lost transport acknowledgement is not replayed on restart',async()=>{
 const f=fixture();for(const phase of ['waiting_user','waiting_approval','waiting_help','queued','cancelled'] as const)await f.coordinator.observe({snapshot:{...f.snapshot,phase},replies:[]});assert.equal(f.decisions.length,0)
 await f.coordinator.observe({snapshot:f.snapshot,replies:[]});f.advance(10*60_000)
 f.ports.send=async()=>{throw Error('lost ack')};await f.coordinator.observe({snapshot:f.snapshot,replies:[]});assert.equal(f.disk.get('a')?.delivery,'uncertain')
 f.advance(60*60_000);await new TaskCoordinator(f.ports).observe({snapshot:f.snapshot,replies:[]});assert.equal(f.sent.length,0)
 await f.coordinator.observe({snapshot:{...f.snapshot,owner:'foreign'},replies:[]});assert.equal(f.errors.length,1)
})
test('wait preserves internal detail without advice or user reports; independent tasks never share question ids',async()=>{
 const f=fixture();f.choose({kind:'wait',text:'',nextCheckMinutes:30})
 await f.coordinator.observe({snapshot:f.snapshot,report:'internal-step',replies:[]});assert.equal(f.sent.length,0)
 f.choose({kind:'ask',text:'是否出现新的卡点？',nextCheckMinutes:10});await f.coordinator.observe({snapshot:{...f.snapshot,id:'b',owner:'other-source/bot/executor'},replies:[]})
 f.advance(30*60_000);await Promise.all([f.coordinator.observe({snapshot:f.snapshot,replies:[]}),f.coordinator.observe({snapshot:{...f.snapshot,id:'b',owner:'other-source/bot/executor'},replies:[]})])
 assert.equal(f.sent.length,2);assert.notEqual(f.sent[0]!.id,f.sent[1]!.id)
})
test('duplicate advice is not resent; terminal reply state is reconciled without another inquiry',async()=>{
 const f=fixture(),o={snapshot:f.snapshot,replies:[]};f.choose({kind:'advise',text:'Use the explicit synthetic input.',nextCheckMinutes:10})
 await f.coordinator.observe({...o,report:'one'});assert.equal(f.sent.length,1)
 const request=f.sent[0]!.id
 await f.coordinator.observe({...o,report:'two',replies:[`reply:${request}`],deliveries:{[request]:'delivered'}});assert.equal(f.sent.length,1)
 await f.coordinator.observe({...o,snapshot:{...f.snapshot,phase:'completed',terminal:true},replies:[`reply:${request}`],deliveries:{[request]:'delivered'}})
 assert.equal(f.disk.get('a')?.delivery,'delivered');assert.equal(f.disk.get('a')?.replyId,`reply:${request}`);assert.equal(f.sent.length,1)
})
test('new blocker reports may get scoped advice while waiting; periodic questions never bypass an approval or user wait',async()=>{
 const f=fixture();f.choose({kind:'advise',text:'Keep the approval pending; first check the already authorized synthetic input.'})
 await f.coordinator.observe({snapshot:{...f.snapshot,phase:'waiting_help'},report:'blocker',replies:[]});assert.equal(f.sent.length,1);assert.equal(f.sent[0]!.kind,'advise')
 f.advance(60*60_000);await f.coordinator.observe({snapshot:{...f.snapshot,phase:'waiting_help'},report:'blocker',replies:[]});assert.equal(f.sent.length,1)
 await f.coordinator.observe({snapshot:{...f.snapshot,phase:'waiting_approval'},report:'approval',replies:[]});assert.equal(f.sent.length,1)
})
