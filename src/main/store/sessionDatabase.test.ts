import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SessionDatabase } from './sessionDatabase.ts'
import type { Session } from '../../shared/types.ts'

test('messages and image payloads survive reopen, updates and deletions atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-session-db-'))
  const file = join(root, 'sessions.sqlite')
  const image = 'a'.repeat(1_000_000)
  const session: Session = { id:'chat', title:'chat', cwd:'/tmp', mode:'agent', botIds:['bot'], activeBotId:'bot', todos:[], createdAt:1, updatedAt:1, messages:[
    { id:'user', role:'user', content:'hello', createdAt:1, attachments:[{ id:'image', kind:'image', name:'image.png', mime:'image/png', data:image }] },
    { id:'tool', role:'tool', content:'done', createdAt:2, toolResult:{ callId:'call', name:'screenshot', ok:true, output:'done', screenshot:image } }
  ] }
  let db = new SessionDatabase(file)
  try {
    db.put(session, true)
    assert.equal(db.hasImported('chat'), true)
    let saved = db.get('chat')!
    assert.ok(JSON.stringify(saved).length < 5000)
    const attachment = saved.messages[0].attachments![0]
    const result = saved.messages[1].toolResult as NonNullable<typeof saved.messages[1]['toolResult']> & {screenshotRef:string}
    assert.equal(db.getBlob(attachment.dataRef!), image)
    assert.equal(db.getBlob(result.screenshotRef), image)
    db.close(); db = new SessionDatabase(file)
    saved = db.get('chat')!
    saved.title = 'renamed'; saved.messages.push({id:'reply', role:'assistant', content:'ok', createdAt:3})
    db.put(saved)
    const loaded = db.get('chat')!
    assert.equal(loaded.title, 'renamed')
    assert.deepEqual(loaded.messages.map((m)=>m.id), ['user','tool','reply'])
    assert.equal(db.getBlob(loaded.messages[0].attachments![0].dataRef!), image)
    assert.throws(() => db.put({ ...loaded, messages:[loaded.messages[0], loaded.messages[0]] }))
    assert.equal(db.get('chat')!.messages.length, 3)
    assert.equal(db.delete('chat'), true)
    assert.equal(db.get('chat'), null)
    assert.equal(db.hasImported('chat'), true)
  } finally { db.close(); await rm(root,{recursive:true,force:true}) }
})
