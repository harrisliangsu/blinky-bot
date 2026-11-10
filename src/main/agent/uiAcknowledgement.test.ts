import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toProviderMessages } from './history.ts'
import { normaliseSession } from '../store/sessionSchema.ts'
import { fingerprints } from '../backends/cli/resumePrompt.ts'

test('visible delivery acknowledgements survive reload without changing the model resume watermark', () => {
 const raw={id:'s',botIds:[],messages:[{id:'u',role:'user',content:'question',createdAt:1},{id:'a',role:'assistant',content:'收到，我会一并考虑。',uiOnly:true,createdAt:2},{id:'u2',role:'user',content:'followup',createdAt:3}]}
 const session=normaliseSession(raw)!
 assert.equal(session.messages[1].uiOnly,true)
 const actual=toProviderMessages(session.messages,{supportsVision:true})
 assert.deepEqual(actual.map(m=>m.content),['question','followup'])
 assert.deepEqual(fingerprints(actual),fingerprints(toProviderMessages([session.messages[0],session.messages[2]],{supportsVision:true})))
})
