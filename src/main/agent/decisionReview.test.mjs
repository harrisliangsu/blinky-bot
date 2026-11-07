import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { connectionTestEnvironment } from '../connectors/testEnvironment.mjs'

test('decision review uses installed contracts and actual permitted tools; off, missing, failed, timed out, deduplicated and restart states remain truthful', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-decision-review-'))
  try {
    const resolveDir = dirname(fileURLToPath(import.meta.url)), bundle = join(root, 'review.cjs')
    await build({ stdin: { resolveDir, loader: 'ts', contents: `
export {decisionReview,interruptDecisionReviews} from './decisionReview';
export {runTool,schemasFor} from '../tools/registry';
export {getSettings,initSettings,saveDecisionSkillReview,updateSettings} from '../settings';
export {flushAll} from '../store/jsonStore';
export {composeSystemPrompt} from './systemPrompt';
` }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent', define: { 'import.meta.glob': 'fixtureGlob' }, banner: { js: 'const fixtureGlob=()=>({});' }, plugins: [{ name: 'isolated-electron', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const app={getVersion:()=>"fixture",isPackaged:false};export const safeStorage={isEncryptionAvailable:()=>false};export const BrowserWindow={getAllWindows:()=>[]};export const shell={};export const Notification={};', loader: 'js' }))
    } }] })
    const worker = join(root, 'worker.cjs')
    await writeFile(worker, `
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{spawnSync}=require('node:child_process');
const app=require('./review.cjs'),root=__dirname;
(async()=>{
await app.initSettings();
if(process.argv[2]==='restart'){assert.equal(app.getSettings().decisionSkillReview,true);console.log('restart-persisted');return;}
const cwd=path.join(root,'project'),skill=path.join(cwd,'.agents/skills/independent-check');await fs.mkdir(skill,{recursive:true});
const contract=path.join(skill,'SKILL.md');
await fs.writeFile(contract,'---\\nname: independent-check\\ndescription: Review development decisions using the local checker and evidence.\\n---\\nRun node review.mjs with the specific subject and evidence. Report uncertainty and never authorize actions.');
await fs.writeFile(path.join(cwd,'review.mjs'),\`import{appendFileSync}from'node:fs';if(process.argv[2]!=='plan'||process.argv[3]!=='synthetic-evidence')throw Error('missing evidence');appendFileSync('invocations.txt','called\\\\n');console.log('Evidence checked: keep task permissions; revise unclear assumptions.');\`);
const ctx={sessionId:'S',botId:'B',backendId:'fixture-api',cwd,dataDir:process.env.OPENBOT_DATA_DIR,signal:new AbortController().signal,emit:()=>{},computerTarget:{kind:'local'},getSettings:app.getSettings,requestApproval:async()=>true};
const begin={action:'begin',node:'development_plan',subject:'Choose an independent task workspace',evidence:'A real repository and two unrelated tasks; synthetic-evidence'};
assert.equal((await app.decisionReview(begin,ctx)).status,'disabled');assert.ok(!app.schemasFor(['shell']).some(x=>x.name==='decision_review'));
await app.saveDecisionSkillReview(true);app.updateSettings({localExecutionPolicy:'always-allow',approvalPolicy:'auto-run'});
assert.ok(app.schemasFor([]).some(x=>x.name==='decision_review'));assert.ok(!app.schemasFor([],{kind:'vm'}).some(x=>x.name==='decision_review'));
const r=await app.decisionReview(begin,ctx);assert.equal(r.status,'pending');const s=r.skills.find(x=>x.name==='independent-check');assert.ok(s);assert.equal(s.contract,contract);
await app.decisionReview({action:'select',review_id:r.review_id,skill_id:s.id},ctx);
const read=await app.runTool({id:'read-contract',name:'read_file',args:{path:contract}},ctx);assert.equal(read.ok,true,read.output);
const shell=await app.runTool({id:'invoke-check',name:'shell',args:{command:JSON.stringify(process.execPath)+' review.mjs plan synthetic-evidence',timeout_ms:1000}},ctx);assert.equal(shell.ok,true,shell.output);
const finish=await app.decisionReview({action:'finish',review_id:r.review_id,status:'reviewed',summary:'The local checker confirmed the evidence; retained ordinary permissions.'},ctx);assert.equal(finish.status,'reviewed');assert.equal(finish.receipts.length,2);
assert.equal((await app.decisionReview(begin,ctx)).duplicate,true);assert.equal((await fs.readFile(path.join(cwd,'invocations.txt'),'utf8')).trim(),'called');
const foreign={...ctx,botId:'OTHER'};await assert.rejects(app.decisionReview({action:'finish',review_id:r.review_id,status:'reviewed',summary:'steal'},foreign),/belong/);
const missing=await app.decisionReview({...begin,subject:'No skills',evidence:'No installed review skill'}, {...ctx,cwd:path.join(root,'empty'),botId:'EMPTY'});assert.equal(missing.status,'unreviewed');assert.equal(missing.reason,'skill-missing');
async function selected(subject){const a=await app.decisionReview({...begin,subject},ctx);await app.decisionReview({action:'select',review_id:a.review_id,skill_id:s.id},ctx);await app.runTool({id:'read-'+subject,name:'read_file',args:{path:contract}},ctx);return a;}
const failed=await selected('Failed review');const fail=await app.runTool({id:'failure',name:'shell',args:{command:JSON.stringify(process.execPath)+' -e '+JSON.stringify('process.exit(1)'),timeout_ms:1000}},ctx);assert.equal(fail.ok,false);
assert.equal((await app.decisionReview({action:'finish',review_id:failed.review_id,status:'reviewed',summary:'Service failed; continue independent work.'},ctx)).status,'unreviewed');
const denied=await selected('Unapproved review');app.updateSettings({denylist:['*DO_NOT_EXECUTE*']});const refusal=await app.runTool({id:'denied',name:'shell',args:{command:'DO_NOT_EXECUTE'}},ctx);assert.equal(refusal.ok,false);assert.equal((await app.decisionReview({action:'finish',review_id:denied.review_id,status:'reviewed',summary:'Denied; did not retry.'},ctx)).status,'unreviewed');app.updateSettings({denylist:[]});
const timeout=await selected('Timed out review');const hang=await app.runTool({id:'timeout',name:'shell',args:{command:JSON.stringify(process.execPath)+' -e '+JSON.stringify('setInterval(()=>{},1000)'),timeout_ms:1000}},ctx);assert.equal(hang.ok,false);assert.equal((await app.decisionReview({action:'finish',review_id:timeout.review_id,status:'unreviewed',summary:'Checker timed out.'},ctx)).status,'unreviewed');
const pending=await selected('Restart interruption');app.interruptDecisionReviews();const replay=await app.decisionReview({...begin,subject:'Restart interruption'},ctx);assert.equal(replay.status,'unreviewed');assert.equal(replay.reason,'interrupted');assert.equal(replay.duplicate,true);
const expired=await selected('Expired review window');const clock=Date.now;Date.now=()=>clock()+121000;try{const expiredCall=await app.runTool({id:'expired',name:'shell',args:{command:'must-not-execute'}},ctx);assert.equal(expiredCall.ok,false);assert.match(expiredCall.output,/timed out/);const independent=await app.runTool({id:'independent-after-timeout',name:'read_file',args:{path:contract}},ctx);assert.equal(independent.ok,true,'An expired review must release independent work');}finally{Date.now=clock;}
const forged=await app.decisionReview({...begin,subject:'No execution'},ctx);const noReceipt=await app.decisionReview({action:'finish',review_id:forged.review_id,status:'reviewed',summary:'unsupported success claim'},ctx);assert.equal(noReceipt.status,'unreviewed');
await app.saveDecisionSkillReview(false);assert.equal((await app.decisionReview(begin,ctx)).status,'disabled');assert.ok(!app.schemasFor(['decision_review']).some(x=>x.name==='decision_review'));
await app.saveDecisionSkillReview(true);await app.flushAll();
const child=spawnSync(process.execPath,[__filename,'restart'],{env:process.env,encoding:'utf8',timeout:10000});assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/restart-persisted/);
const records=await fs.readdir(path.join(ctx.dataDir,'decision-reviews'));for(const file of records){const body=await fs.readFile(path.join(ctx.dataDir,'decision-reviews',file),'utf8');assert.ok(!body.includes('synthetic-evidence'));assert.ok(!body.includes('process.exit'));}
console.log(JSON.stringify({cases:10,actualToolExecution:true,externalCredentials:false}));
})().catch(e=>{console.error(e);process.exitCode=1});
`)
    const env = await connectionTestEnvironment(root)
    // Real tool commands run in a clean shell, with no user's shell startup files.
    env.SHELL = '/bin/sh'
    const run = spawnSync(process.execPath, [worker], { env, encoding: 'utf8', timeout: 24000 })
    assert.equal(run.status, 0, run.stderr + run.stdout)
    assert.match(run.stdout, /"actualToolExecution":true/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
