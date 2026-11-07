import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const mocks={
 './store/backendSecrets':`export const backendApiKey=()=>undefined;export const hasBackendApiKey=()=>false;export const clearBackendApiKey=()=>{};export const setBackendApiKey=()=>{throw Error('credentials are outside this test')}`,
 './store/mcpSecrets':`export const mcpBearerToken=()=>undefined;export const hasMcpBearerToken=()=>false;export const clearMcpBearerToken=()=>{};export const setMcpBearerToken=()=>{throw Error('credentials are outside this test')};export const flushMcpSecrets=async()=>{};export const stageMcpBearerToken=()=>{throw Error('credentials are outside this test')}`,
 './store/bots':`export const listBots=()=>[]`
}
const bundled=await build({stdin:{contents:`export {initSettings,getSettings,savePermissionEdit,appendSetting} from './settings.ts'`,resolveDir:dirname(fileURLToPath(import.meta.url)),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,
 plugins:[{name:'no-credentials',setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(mocks,a.path)?{path:a.path,namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'js'}))}}]})

test('permission edits persist across process-module reloads and concurrent edits preserve old user data',async()=>{
 const root=await mkdtemp(join(tmpdir(),'blinky-permission-save-')),prior=process.env.OPENBOT_DATA_DIR
 process.env.OPENBOT_DATA_DIR=root
 try{
  await writeFile(join(root,'settings.json'),JSON.stringify({approvalPolicy:'ask-first-time',allowlist:['git status *'],denylist:['/fixture-secret'],rules:'old prompt instructions',theme:'dark'}))
  const url=`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`
  const api=await import(url+'#one');await api.initSettings()
  assert.equal(api.getSettings().localExecutionPolicy,'ask-every-time')
  const natural={id:'natural-ask',version:1,effect:'ask',text:'发布代码前询问我'}
  const changes=Promise.all([
   api.savePermissionEdit({kind:'semantic-rule',rule:natural}),
   api.savePermissionEdit({kind:'rule',list:'asklist',value:'tool:shell'}),
   api.savePermissionEdit({kind:'rule',list:'allowlist',value:'tool:read_file'}),
   api.savePermissionEdit({kind:'options',localExecutionPolicy:'never-allow',automaticReview:false})
  ])
  api.appendSetting('denylist','tool:edit_file');await changes
  await api.savePermissionEdit({kind:'rule',list:'asklist',previous:'tool:shell',value:'git push *'})
  await assert.rejects(api.savePermissionEdit({kind:'rule',list:'asklist',previous:'tool:shell',value:'stale-edit'}),/changed/)
  await assert.rejects(api.savePermissionEdit({kind:'rule',list:'not-a-list',value:'invalid'}),/Invalid/)
  const edited={...natural,text:'发布到远端仓库前询问我'}
  await api.savePermissionEdit({kind:'semantic-rule',rule:edited,previous:natural})
  await assert.rejects(api.savePermissionEdit({kind:'semantic-rule',rule:natural,previous:natural}),/changed/)
  await assert.rejects(api.savePermissionEdit({kind:'semantic-rule',rule:{...natural,version:2}}),/Invalid/)
  const disk=JSON.parse(await readFile(join(root,'settings.json'),'utf8'))
  assert.deepEqual(disk.semanticPermissionRules,[edited])
  assert.equal(disk.localExecutionPolicy,'never-allow');assert.equal(disk.automaticReview,false)
  assert.deepEqual(disk.allowlist,['git status *','tool:read_file']);assert.deepEqual(disk.asklist,['git push *'])
  assert.deepEqual(disk.denylist,['/fixture-secret','tool:edit_file']);assert.equal(disk.rules,'old prompt instructions');assert.equal(disk.theme,'dark')
  const reboot=await import(url+'#two');await reboot.initSettings()
  assert.deepEqual(reboot.getSettings().semanticPermissionRules,[edited])
  assert.equal(reboot.getSettings().localExecutionPolicy,'never-allow');assert.deepEqual(reboot.getSettings().asklist,['git push *'])
 }finally{if(prior===undefined)delete process.env.OPENBOT_DATA_DIR;else process.env.OPENBOT_DATA_DIR=prior;await rm(root,{recursive:true,force:true})}
})
