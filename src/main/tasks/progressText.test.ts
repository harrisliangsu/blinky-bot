import assert from 'node:assert/strict'
import {test} from 'node:test'
import {agentProgressName,agentProgressReport,briefProgressText} from './progressText'
test('Agent name follows its real task display title and actual session fallback, never a model or Bot label',()=>{
 assert.equal(agentProgressName('搜索进度','Background execution'),'搜索进度')
 assert.equal(agentProgressName('  ','文档检查会话'),'文档检查会话')
 assert.equal(agentProgressName(undefined,undefined),'未命名执行会话')
 assert.equal(agentProgressName('同名会话','另一名称'),'同名会话')
})
test('progress is short, natural and excludes internal jargon and hash values',()=>{
 const hash='a'.repeat(64),text=agentProgressReport('代码核对',`已完成里程碑；SHA-256: ${hash}\n`+'正在核对修改。'.repeat(30))
 assert.ok([...text].length<=40+1+72);assert.equal(/里程碑|SHA-256|a{40}/i.test(text),false)
 assert.match(text,/^代码核对：/);assert.match(text,/…$/)
 assert.equal(briefProgressText('等待用户回答。'),'等待用户回答。')
})
