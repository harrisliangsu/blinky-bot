import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { createSession, getSession, loadSessions } from '../store/sessions.ts'
import { sessions } from './sessionGateway.ts'

test('failed image persistence is not visible in the authoritative session cache', async () => {
 const root=await mkdtemp(join(tmpdir(),'blinky-session-failure-')), old=process.env.OPENBOT_DATA_DIR
 process.env.OPENBOT_DATA_DIR=root
 try {
  await loadSessions()
  const session=createSession(['bot']), data='a'.repeat(100_000), ref=createHash('sha256').update(data).digest('hex')
  await mkdir(join(root,'attachments',ref))
  const ok=await sessions.update(session,s=>s.messages.push({id:'failed',role:'user',content:'x',createdAt:1,attachments:[{id:'a',kind:'image',name:'x',data}]}))
  assert.equal(ok,false)
  assert.equal(getSession(session.id)?.messages.some(m=>m.id==='failed'),false)
 } finally {if(old===undefined)delete process.env.OPENBOT_DATA_DIR;else process.env.OPENBOT_DATA_DIR=old;await rm(root,{recursive:true,force:true})}
})
