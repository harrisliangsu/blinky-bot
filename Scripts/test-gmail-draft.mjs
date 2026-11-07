/** Isolated main-process draft test with fake Google transport; no browser or real mailbox. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-gmail-core-')),data=path.join(root,'data'),bundle=path.join(root,'harness.mjs'),trace=path.join(root,'trace'),drafts=path.join(process.cwd(),'src/main/connectors/gmailDrafts.ts'),oauth=path.join(process.cwd(),'src/main/connectors/googleOAuth.ts'),secrets=path.join(process.cwd(),'src/main/connectors/googleSecrets.ts')
await fs.mkdir(data)
const entry=`
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {createGmailDraft,listGmailDrafts,actOnGmailDraft} from ${JSON.stringify(drafts)};import {setGoogleOAuthTransportForTests} from ${JSON.stringify(oauth)};import {saveGoogleCredentials,setGoogleStorageForTests} from ${JSON.stringify(secrets)};
setGoogleStorageForTests({isEncryptionAvailable:()=>true,encryptString:v=>Buffer.from(v.split('').reverse().join('')),decryptString:b=>b.toString().split('').reverse().join('')});
let count=0;setGoogleOAuthTransportForTests(async(input,init)=>{const u=String(input);if(u==='https://oauth2.googleapis.com/token')return Response.json({access_token:'fixture-access',expires_in:3600});if(u==='https://gmail.googleapis.com/gmail/v1/users/me/messages/send'){count++;await fs.appendFile(process.env.TRACE,String(init.body)+'\\n');if(count===2)return new Response('',{status:500});if(count===3)return new Promise(()=>{});return Response.json({id:'fixture-1'})}throw Error('unexpected network target')});
if(process.env.PHASE==='create'){
await saveGoogleCredentials('gmail',{clientId:'123456789-test.apps.googleusercontent.com',refreshToken:'fixture-refresh',scopes:['openid','email','https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send'],account:'sender@example.test'});
const first=await createGmailDraft('source','blinky',{to:'recipient@example.test',subject:'First',body:'Fixture body'});assert.equal(await fs.readFile(process.env.TRACE,'utf8').catch(()=>''),'');assert.equal(first.status,'draft');
const sent=await actOnGmailDraft(first.id,'source','send');assert.equal(sent.status,'sent');assert.equal(sent.remoteId,'fixture-1');await assert.rejects(actOnGmailDraft(first.id,'source','send'));
const accountDraft=await createGmailDraft('source','blinky',{to:'recipient@example.test',subject:'Account',body:'Fixture body'});const credentials={clientId:'123456789-test.apps.googleusercontent.com',refreshToken:'fixture-refresh',scopes:['openid','email','https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send'],account:'other@example.test'};await saveGoogleCredentials('gmail',credentials);await assert.rejects(actOnGmailDraft(accountDraft.id,'source','send'),/account/);await saveGoogleCredentials('gmail',{...credentials,account:'sender@example.test'});assert.equal((await actOnGmailDraft(accountDraft.id,'source','cancel')).status,'cancelled');
const second=await createGmailDraft('source','blinky',{to:'recipient@example.test',subject:'Second',body:'Fixture body'});assert.equal((await actOnGmailDraft(second.id,'source','send')).status,'uncertain');
const third=await createGmailDraft('source','blinky',{to:'recipient@example.test',subject:'Third',body:'Fixture body'});void actOnGmailDraft(third.id,'source','send');setInterval(()=>{},1000);
}else{const all=await listGmailDrafts('source');assert.deepEqual(all.map(d=>d.status),['sent','cancelled','uncertain','uncertain']);assert.equal((await fs.readFile(process.env.TRACE,'utf8')).trim().split('\\n').length,3);await assert.rejects(actOnGmailDraft(all[3].id,'source','send'));console.log(JSON.stringify({confirmedOnly:true,accountBound:true,cancelNoSend:true,oneSend:true,uncertainNotRetried:true,crashNotRetried:true,restartReadback:true}));}
`
try {
 await build({stdin:{contents:entry,resolveDir:process.cwd(),sourcefile:'gmail-test-entry.ts',loader:'ts'},outfile:bundle,bundle:true,platform:'node',format:'esm',external:['electron'],logLevel:'silent',plugins:[{name:'isolate-test-context',setup(b){b.onResolve({filter:/^\.\.\/(agent\/events|store\/(bots|sessions|tasks))$/},args=>args.importer.endsWith('/connectors/gmailDrafts.ts')?{path:args.path,namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.endsWith('/events')?'export function broadcast(){}':args.path.endsWith('/bots')?'export function getBot(){return {id:"blinky"}}':args.path.endsWith('/sessions')?'export function getSession(id){return {id,botIds:["blinky"],activeBotId:"blinky",archived:false}}':'export function listTasks(){return []}',loader:'js'}))}}]})
 const env={...process.env,OPENBOT_DATA_DIR:data,TRACE:trace,PHASE:'create'}
 const child=spawn(process.execPath,[bundle],{env,stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',x=>stderr+=x)
 const deadline=Date.now()+15000;while(Date.now()<deadline){const lines=(await fs.readFile(trace,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean);if(lines.length===3)break;if(child.exitCode!==null)throw Error('draft setup failed: '+stderr);await delay(50)}
 assert.equal((await fs.readFile(trace,'utf8')).trim().split('\n').length,3,'third send did not start')
 child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve))
 const result=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[bundle],{env:{...env,PHASE:'recover'},stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('close',code=>code===0?resolve(out):reject(Error(err)))})
 const sends=(await fs.readFile(trace,'utf8')).trim().split('\n').map(JSON.parse);assert.match(Buffer.from(sends[0].raw,'base64url').toString(),/To: recipient@example\.test/)
 process.stdout.write(String(result))
} finally { await fs.rm(root,{recursive:true,force:true}) }
