import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rename,mkdir,rmdir,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {enqueueRoomMessageOnce,getMessageQueue,loadMessageQueues} from './messageQueue.ts'
const root=await mkdtemp(join(tmpdir(),'blinky-room-queue-'));process.env.OPENBOT_DATA_DIR=root
const id='room-'+'a'.repeat(64)
test('LAN receipt ids commit once and reject mismatched text/revoked requests',async()=>{
 await loadMessageQueues();await enqueueRoomMessageOnce('chat',id,'[room guest] synthetic')
 await Promise.all([enqueueRoomMessageOnce('chat',id,'[room guest] synthetic'),enqueueRoomMessageOnce('chat',id,'[room guest] synthetic')])
 assert.equal(getMessageQueue('chat').items.length,1)
 await assert.rejects(enqueueRoomMessageOnce('chat',id,'different'))
 await assert.rejects(enqueueRoomMessageOnce('chat','room-'+'b'.repeat(64),'revoked',false,()=>false))
 assert.equal(getMessageQueue('chat').items.length,1)
})
test('a failed durable LAN enqueue does not publish a successful in-memory receipt',async()=>{
 const file=join(root,'message-queues.json');await rename(file,file+'.saved');await mkdir(file)
 await assert.rejects(enqueueRoomMessageOnce('chat','room-'+'c'.repeat(64),'failure'))
 assert.equal(getMessageQueue('chat').items.length,1)
 await rmdir(file);await rename(file+'.saved',file);await enqueueRoomMessageOnce('chat','room-'+'c'.repeat(64),'failure')
 assert.equal(JSON.parse(await readFile(file,'utf8')).queues.chat.items.length,2)
})
