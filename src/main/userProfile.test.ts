import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp,readFile,rename,mkdir,rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSettings,updateSettings,saveUserProfile } from './settings.ts'
import { flushAll } from './store/jsonStore.ts'

const root=await mkdtemp(join(tmpdir(),'blinky-profile-store-'));process.env.OPENBOT_DATA_DIR=root
const file=join(root,'settings.json')
test('profile save acknowledges real disk data and preserves hidden legacy fields',async()=>{
  updateSettings({profileName:'Legacy',profileEmoji:'L',profileColor:'#123456',denylist:['keep']});await flushAll()
  const saved=await saveUserProfile({profileName:'  Reader  ',profileImage:''})
  const disk=JSON.parse(await readFile(file,'utf8'))
  assert.equal(saved.profileName,'Reader');assert.equal(disk.profileName,'Reader');assert.equal(disk.profileEmoji,'L');assert.equal(disk.profileColor,'#123456');assert.deepEqual(disk.denylist,['keep'])
})
test('invalid input and disk failure do not publish a phantom identity; repair permits retry',async()=>{
  for(const patch of [{profileName:'X'.repeat(81)},{profileImage:'file:///private/photo.png'}])await assert.rejects(saveUserProfile(patch))
  const before=getSettings().profileName
  await rename(file,file+'.saved');await mkdir(file)
  await assert.rejects(saveUserProfile({profileName:'Failed'}));assert.equal(getSettings().profileName,before)
  await rmdir(file);await rename(file+'.saved',file)
  await saveUserProfile({profileName:'Retry'});assert.equal(JSON.parse(await readFile(file,'utf8')).profileName,'Retry')
})
test('profile writes retain concurrent settings and never accept unrelated profile patch fields',async()=>{
  const pending=saveUserProfile({profileName:'Concurrent',denylist:['overwrite']} as never)
  updateSettings({theme:'light'})
  await pending;await flushAll()
  const disk=JSON.parse(await readFile(file,'utf8'))
  assert.equal(disk.profileName,'Concurrent');assert.equal(disk.theme,'light');assert.deepEqual(disk.denylist,['keep'])
  await saveUserProfile({profileName:'  '});assert.equal(getSettings().profileName,'')
})

test('merged profile saves retain captured routing, permissions, provider and connection settings',async()=>{
  updateSettings({
    quickDecision:{backendId:'openai',modelId:'routing-fixture'},
    approvalPolicy:'ask-every-time',allowlist:['read-only-fixture'],denylist:['keep-forbidden'],rules:'Keep user instructions',
    backends:{...getSettings().backends,openai:{enabled:false,added:true,defaultModelId:'provider-fixture',baseUrl:'https://api.openai.com/v1'}},
    apps:{...getSettings().apps,gmail:{pending:true}}
  })
  await flushAll()
  const preserve=(s:ReturnType<typeof getSettings>)=>({quickDecision:s.quickDecision,approvalPolicy:s.approvalPolicy,allowlist:s.allowlist,denylist:s.denylist,rules:s.rules,provider:{enabled:s.backends.openai.enabled,added:s.backends.openai.added,defaultModelId:s.backends.openai.defaultModelId,baseUrl:s.backends.openai.baseUrl},apps:s.apps})
  const expected=preserve(getSettings())
  const first=saveUserProfile({profileName:'Merged Reader'})
  // Enter the asynchronous write before a second settings mutation arrives.
  await new Promise<void>(resolve=>setImmediate(resolve))
  updateSettings({theme:'dark'})
  const second=saveUserProfile({profileName:'Merged Reader Latest',profileImage:''})
  await Promise.all([first,second]);await flushAll()
  const disk=JSON.parse(await readFile(file,'utf8'))
  assert.equal(disk.profileName,'Merged Reader Latest');assert.equal(disk.theme,'dark')
  assert.deepEqual(preserve(getSettings()),expected);assert.deepEqual(preserve(disk),expected)
})

test('profile saves preserve explicit memory extraction choices from the current normaliser',async()=>{
  for (const memoryExtraction of ['off','api'] as const) {
    updateSettings({memoryExtraction});await flushAll()
    await saveUserProfile({profileName:`Memory ${memoryExtraction}`})
    assert.equal(getSettings().memoryExtraction,memoryExtraction)
    assert.equal(JSON.parse(await readFile(file,'utf8')).memoryExtraction,memoryExtraction)
  }
})
