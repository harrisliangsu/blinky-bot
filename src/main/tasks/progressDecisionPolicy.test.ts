import assert from 'node:assert/strict'
import {test} from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {parseProgressDecision} from './progressDecisionPolicy'
import type {ProgressSnapshot} from './progressMonitor'
// Keep the vault scrubber away from this machine's real vault document: with a
// fresh empty data root the literal text passes through unchanged.
process.env['OPENBOT_DATA_DIR'] = mkdtempSync(join(tmpdir(), 'progress-policy-'))
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
const returned:ProgressSnapshot={id:'task',owner:'source/bot/session',title:'产品报告',phase:'completed',progress:'proof',detail:'',terminal:true,needsAttention:false,evidence:[{id:'result:task',kind:'report',text:'已整理产品理念与模块进展报告'},{id:'deliverables:task',kind:'report',text:JSON.stringify({workspaceRoot:'/tmp/task-workspace',verifiedFiles:['report.md']})}]}
test('a returned-task notice may carry the deliverable location and key findings beyond the milestone cap',()=>{
 const text='报告已完成：/tmp/task-workspace/report.md。报告梳理了产品理念与设计理念、需求范围的解释口径，以及 18 个模块的源码整合与验收状态，逐项区分了已实现、已验证和仍有缺口的部分；同时指出统一验收、真实模型闭环、多 CLI 真实运行等仍是待验证缺口，正式安装包与当前工作树的对应关系还需你自行核对。'
 const decision=parseProgressDecision(JSON.stringify({kind:'milestone',text,evidenceIds:['result:task','deliverables:task']}),returned)
 assert.equal(decision?.kind,'milestone')
 assert.ok([...decision.text].length>160)
})
test('a completed notice beyond 500 characters stays unassessed',()=>{
 assert.equal(parseProgressDecision(JSON.stringify({kind:'milestone',text:'长'.repeat(501),evidenceIds:['result:task']}),returned),null)
})
test('a completed notice must cite same-task evidence ids',()=>{
 assert.equal(parseProgressDecision(JSON.stringify({kind:'milestone',text:'报告在 /tmp/task-workspace/report.md。',evidenceIds:['elsewhere-proof']}),returned),null)
})

test('a digest bundles up to three urgent lines and follows the same evidence gate',()=>{
 const digest=parseProgressDecision(JSON.stringify({kind:'digest',lines:['A 等待你确认，请打开任务查看。','B 报告已完成：/tmp/ws/report.md。','C 正在处理“导出”。','D 不该出现'],evidenceIds:['result:task']}),returned)
 assert.equal(digest?.kind,'digest')
 assert.equal(digest.lines.length,3)
 assert.equal(digest.lines[3],undefined)
 assert.ok(!digest.lines.some(l=>l.includes('不该出现')))
 const noEvidence=parseProgressDecision(JSON.stringify({kind:'digest',lines:['A 卡住。']}),{...returned,phase:'running',terminal:false,needsAttention:false,evidence:[{id:'same-task-proof',kind:'tool',text:'synthetic evidence'}]})
 assert.equal(noEvidence,null)
 const withEvidence=parseProgressDecision(JSON.stringify({kind:'digest',lines:['A 卡住。'],evidenceIds:['same-task-proof']}),{...returned,phase:'running',terminal:false,needsAttention:false,evidence:[{id:'same-task-proof',kind:'tool',text:'synthetic evidence'}]})
 assert.equal(withEvidence?.kind,'digest')
})
