import assert from 'node:assert/strict'
import {test} from 'node:test'
import {parseProgressDecision} from './progressDecisionPolicy'
import type {ProgressSnapshot} from './progressMonitor'
const s:ProgressSnapshot={id:'task',owner:'source/bot/session',title:'图片发送',phase:'running',progress:'proof',detail:'',terminal:false,needsAttention:false,evidence:[{id:'same-task-proof',kind:'tool',text:'synthetic evidence'}]}
test('only structured tool-free decisions with same-task evidence may publish a milestone',()=>{
 assert.equal(parseProgressDecision('copy this raw Agent output',s),null)
 assert.equal(parseProgressDecision('{"kind":"milestone","text":"已能发送图片。","evidenceIds":["sibling-proof"]}',s),null)
 assert.equal(parseProgressDecision('{"kind":"milestone","text":"已能发送图片。","evidenceIds":[]}',s),null)
 assert.deepEqual(parseProgressDecision('{"kind":"silent"}',s),{kind:'silent'})
 assert.equal(parseProgressDecision('{"kind":"milestone","text":"现在能发送图片，刷新也能保留草稿。","evidenceIds":["same-task-proof"]}',s)?.kind,'milestone')
})
test('required action can be stated without leaking a private approval body; oversized prose stays unassessed',()=>{
 assert.equal(parseProgressDecision('{"kind":"milestone","text":"继续前需要你确认，请打开任务查看。","evidenceIds":[]}',{...s,phase:'waiting_approval'})?.kind,'milestone')
 assert.equal(parseProgressDecision(JSON.stringify({kind:'milestone',text:'a'.repeat(161),evidenceIds:['same-task-proof']}),s),null)
})
