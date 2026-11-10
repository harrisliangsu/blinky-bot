import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SessionCollection } from './sessionCollection.ts'
import { SessionDatabase } from './sessionDatabase.ts'

test('legacy sessions migrate without overwriting original, lazy images survive a second launch', async () => {
 const root = await mkdtemp(join(tmpdir(), 'blinky-migrate-')), old = process.env.OPENBOT_DATA_DIR
 process.env.OPENBOT_DATA_DIR = root
 try {
  await mkdir(join(root,'sessions'))
  const image = 'b'.repeat(4_000_000)
  const legacy = {id:'legacy',title:'old',cwd:'/tmp',mode:'agent',botIds:['bot'],activeBotId:'bot',todos:[],createdAt:1,updatedAt:1,messages:[{id:'m1',role:'user',content:'image',createdAt:1,attachments:[{id:'a',kind:'image',name:'a.png',mime:'image/png',data:image}]}]}
  const original = JSON.stringify(legacy), file = join(root,'sessions','legacy.json')
  await writeFile(file,original)
  const first = new SessionCollection(); await first.load()
  assert.equal(first.loadWasIncomplete,false)
  const saved = first.get('legacy')!
  assert.ok(JSON.stringify(saved).length < 2000)
  assert.equal(first.blob(saved.messages[0].attachments![0].dataRef!),image)
  first.put({...saved,title:'updated',messages:[...saved.messages,{id:'reply',role:'assistant',content:'ok',createdAt:2,streaming:true}]})
  assert.equal(first.get('legacy')!.messages[1].streaming,true)
  const second = new SessionCollection(); await second.load()
  assert.equal(second.get('legacy')!.title,'updated')
  assert.match(second.get('legacy')!.messages[1].error!,/中断/)
  assert.equal(await readFile(file,'utf8'),original)
  assert.equal(second.blob(second.get('legacy')!.messages[0].attachments![0].dataRef!),image)
  second.delete('legacy')
  const third = new SessionCollection(); await third.load()
  assert.equal(third.get('legacy'),null)
 } finally { if(old===undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR=old; await rm(root,{recursive:true,force:true}) }
})

test('startup and navigation only read metadata; selecting one session reads only that history', async () => {
 const root=await mkdtemp(join(tmpdir(),'blinky-lazy-store-')),old=process.env.OPENBOT_DATA_DIR
 process.env.OPENBOT_DATA_DIR=root
 const original=SessionDatabase.prototype.get
 let reads=0
 try {
  const db=new SessionDatabase(join(root,'sessions.sqlite'))
  for(let i=0;i<30;i++) db.put({id:`s-${i}`,title:`Synthetic ${i}`,cwd:root,mode:'agent',botIds:[],activeBotId:'',messages:Array.from({length:100},(_,n)=>({id:`m-${n}`,role:'assistant' as const,content:'synthetic '.repeat(100),createdAt:1})),todos:[],createdAt:1,updatedAt:1})
  db.close()
  SessionDatabase.prototype.get=function(id){reads++;return original.call(this,id)}
  const store=new SessionCollection();await store.load()
  assert.equal(reads,0)
  assert.equal(store.entries().length,30)
  assert.equal(store.entries()[0].messageCount,100)
  assert.equal(reads,0)
  const selected=store.get('s-4')!
  assert.equal(reads,1);assert.equal(selected.messages.length,100)
  assert.equal(store.get('s-4'),selected);assert.equal(reads,1)
  store.put({...selected,title:'Renamed',messages:[...selected.messages,{id:'final',role:'assistant',content:'saved',createdAt:2,streaming:true}]})
  assert.equal(store.entries().find(row=>row.session.id==='s-4')?.messageCount,101)
  assert.equal(store.get('s-4')!.messages.at(-1)?.streaming,true)
  store.delete('s-4');assert.equal(store.get('s-4'),null)
  assert.equal(store.entries().length,29)
 } finally { SessionDatabase.prototype.get=original;if(old===undefined)delete process.env.OPENBOT_DATA_DIR;else process.env.OPENBOT_DATA_DIR=old;await rm(root,{recursive:true,force:true}) }
})

test('a damaged legacy file is retained and does not prevent other sessions from importing', async () => {
 const root = await mkdtemp(join(tmpdir(), 'blinky-damaged-')), old = process.env.OPENBOT_DATA_DIR
 process.env.OPENBOT_DATA_DIR = root
 try {
  await mkdir(join(root,'sessions'))
  await writeFile(join(root,'sessions','bad.json'),'{broken')
  await writeFile(join(root,'sessions','good.json'),JSON.stringify({id:'good',title:'good',cwd:'/tmp',mode:'agent',botIds:[],activeBotId:'',messages:[],todos:[],createdAt:1,updatedAt:1}))
  const store = new SessionCollection(); await store.load()
  assert.equal(store.loadWasIncomplete,true)
  assert.equal(store.get('good')?.title,'good')
  assert.equal(await readFile(join(root,'sessions','bad.json'),'utf8'),'{broken')
 } finally { if(old===undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR=old; await rm(root,{recursive:true,force:true}) }
})

test('attachment write failure does not import or overwrite the legacy transcript', async () => {
 const root=await mkdtemp(join(tmpdir(),'blinky-image-failure-')), old=process.env.OPENBOT_DATA_DIR
 process.env.OPENBOT_DATA_DIR=root
 try {
  const { createHash } = await import('node:crypto')
  await mkdir(join(root,'sessions'));await mkdir(join(root,'attachments'))
  const data='c'.repeat(200000), hash=createHash('sha256').update(data).digest('hex')
  await mkdir(join(root,'attachments',hash))
  const file=join(root,'sessions','source.json'), original=JSON.stringify({id:'source',title:'source',cwd:'/tmp',mode:'agent',botIds:[],activeBotId:'',messages:[{id:'m',role:'user',content:'x',createdAt:1,attachments:[{id:'a',kind:'image',name:'x.png',mime:'image/png',data}]}],todos:[],createdAt:1,updatedAt:1})
  await writeFile(file,original)
  const first=new SessionCollection();await first.load();assert.equal(first.loadWasIncomplete,true);assert.equal(first.get('source'),null);assert.equal(await readFile(file,'utf8'),original)
  await rm(join(root,'attachments',hash),{recursive:true})
  const second=new SessionCollection();await second.load();assert.equal(second.loadWasIncomplete,false);assert.ok(second.get('source'));assert.equal(await readFile(file,'utf8'),original)
 } finally { if(old===undefined)delete process.env.OPENBOT_DATA_DIR;else process.env.OPENBOT_DATA_DIR=old;await rm(root,{recursive:true,force:true}) }
})
