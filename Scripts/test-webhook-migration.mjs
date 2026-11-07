/** Migration, restart and deduplication tests using disposable local data only. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

const repo=process.cwd(),root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-webhook-migration-'))
const legacy=path.join(root,'webhook-inbox'),routine='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',bot='test-bot'
const id=event=>'webhook-'+createHash('sha256').update(routine+'\0'+event).digest('hex')
const item=(event,status)=>({id:id(event),routineId:routine,botId:bot,name:'Fixture',instruction:'DO_TEST',createdAt:123,status})
await fs.mkdir(legacy)
for(const [event,status] of [['event-a','pending'],['event-b','queued']])await fs.writeFile(path.join(legacy,id(event)+'.json'),JSON.stringify(item(event,status)))

const childCode=String.raw`
import assert from 'node:assert/strict'
import {acceptWebhookSignal,pendingWebhookSignals,markWebhookQueued} from './src/main/routines/webhookInbox.ts'
const r='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',b='test-bot',event=x=>acceptWebhookSignal(r,b,x,'Fixture','DO_TEST')
const mode=process.env.TEST_PHASE
if(mode==='first'){
 const pending=await pendingWebhookSignals();assert.equal(pending.length,1);assert.equal((await event('event-b')).status,'queued')
 await markWebhookQueued(pending[0].id);assert.equal((await event('event-a')).status,'queued');assert.equal((await event('event-c')).status,'pending')
}else if(mode==='restart'){
 const pending=await pendingWebhookSignals();assert.equal(pending.length,1);assert.equal((await event('event-a')).status,'queued');assert.equal((await event('event-b')).status,'queued')
}else if(mode==='large'){
 assert.equal((await event('event-d')).status,'pending');assert.equal((await event('event-a')).status,'queued');assert.equal((await pendingWebhookSignals()).length,2)
}else if(mode==='mass'){
 assert.equal((await pendingWebhookSignals()).length,0);assert.equal((await event('after-mass')).status,'pending')
}else await pendingWebhookSignals()
process.stdout.write('ok')
`
function child(phase,dir=root){return new Promise((resolve,reject)=>{let out='',err='';const p=spawn(process.execPath,['--experimental-transform-types','--import',path.join(repo,'scripts/register-ts.mjs'),'--input-type=module','-e',childCode],{cwd:repo,env:{...process.env,OPENBOT_DATA_DIR:dir,TEST_PHASE:phase},stdio:['ignore','pipe','pipe']});p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('close',(code,signal)=>resolve({code,signal,out,err}))})}
try{
 let result=await child('first');assert.equal(result.code,0,result.err);assert.equal(result.out,'ok')
 const backups=(await fs.readdir(root)).filter(name=>name.startsWith('webhook-inbox.migrated-'));assert.equal(backups.length,1)
 assert.equal(JSON.parse(await fs.readFile(path.join(root,backups[0],id('event-a')+'.json'),'utf8')).status,'pending')
 // Reimporting a stale legacy snapshot simulates a crash after commit but before rename.
 await fs.cp(path.join(root,backups[0]),legacy,{recursive:true})
 result=await child('restart');assert.equal(result.code,0,result.err)
 const db=new DatabaseSync(path.join(root,'webhook-inbox.sqlite'))
 try{
  db.exec('BEGIN IMMEDIATE')
  const insert=db.prepare("INSERT OR IGNORE INTO signals (id,routineId,botId,name,instruction,createdAt,status) VALUES (?,?,?,'','',?,'queued')")
  for(let i=0;i<10001;i++)insert.run('webhook-'+i.toString(16).padStart(64,'0'),routine,bot,i)
  db.exec('COMMIT')
 }finally{db.close()}
 result=await child('large');assert.equal(result.code,0,result.err)
 // A process killed before COMMIT must not leave a half-accepted signal.
 const crashId='webhook-'+'e'.repeat(64)
 const crashCode=`const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.TEST_DB);db.exec('BEGIN IMMEDIATE');db.prepare("INSERT INTO signals (id,routineId,botId,name,instruction,createdAt,status) VALUES (?,?,?,?,?,?,?)").run(process.env.TEST_ID,process.env.TEST_ROUTINE,'test-bot','Fixture','DO_TEST',1,'pending');process.kill(process.pid,'SIGKILL')`
 const crash=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['-e',crashCode],{env:{...process.env,TEST_DB:path.join(root,'webhook-inbox.sqlite'),TEST_ID:crashId,TEST_ROUTINE:routine},stdio:'ignore'});p.on('error',reject);p.on('close',(code,signal)=>resolve({code,signal}))})
 assert.equal(crash.signal,'SIGKILL')
 const check=new DatabaseSync(path.join(root,'webhook-inbox.sqlite'));try{assert.equal(check.prepare('SELECT id FROM signals WHERE id = ?').get(crashId),undefined)}finally{check.close()}
 // An invalid legacy record must fail without discarding it or changing existing history.
 await fs.mkdir(legacy);const broken=path.join(legacy,'webhook-'+'f'.repeat(64)+'.json');await fs.writeFile(broken,'{broken')
 result=await child('invalid');assert.notEqual(result.code,0);assert.equal(await fs.readFile(broken,'utf8'),'{broken')
 await fs.rm(broken);await fs.rmdir(legacy)
 result=await child('large');assert.equal(result.code,0,result.err)
 const massRoot=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-webhook-mass-'))
 try{
  const dir=path.join(massRoot,'webhook-inbox');await fs.mkdir(dir)
  for(let start=0;start<10001;start+=64)await Promise.all(Array.from({length:Math.min(64,10001-start)},(_,offset)=>{const n=start+offset,entry={...item('unused','queued'),id:'webhook-'+n.toString(16).padStart(64,'0')};return fs.writeFile(path.join(dir,entry.id+'.json'),JSON.stringify(entry))}))
  result=await child('mass',massRoot);assert.equal(result.code,0,result.err)
  const massDb=new DatabaseSync(path.join(massRoot,'webhook-inbox.sqlite'));try{assert.equal(massDb.prepare('SELECT count(*) AS count FROM signals').get().count,10002)}finally{massDb.close()}
  const archives=(await fs.readdir(massRoot)).filter(name=>name.startsWith('webhook-inbox.migrated-'));assert.equal(archives.length,1);assert.equal((await fs.readdir(path.join(massRoot,archives[0]))).length,10001)
 }finally{await fs.rm(massRoot,{recursive:true,force:true})}
 console.log(JSON.stringify({legacyImported:true,legacyBackupKept:true,staleReimportNoReplay:true,moreThanTenThousandAccepted:true,largeLegacyMigrated:true,uncommittedCrashRolledBack:true,damagedLegacyPreserved:true,restartDeduplicated:true}))
}finally{await fs.rm(root,{recursive:true,force:true})}
