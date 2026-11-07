import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SafeStorage } from 'electron'
import { addVaultItem, updateVaultItem, listVaultItems, useVaultField, setVaultStorageForTests } from './vault.ts'
test('vault edits preserve ciphertext for blank fields and replace selected values atomically',async()=>{
  process.env.OPENBOT_DATA_DIR=await mkdtemp(join(tmpdir(),'blinky-vault-update-'))
  setVaultStorageForTests({isEncryptionAvailable:()=>true,encryptString:(s:string)=>Buffer.from('fixture:'+s),decryptString:(b:Buffer)=>b.toString().slice(8)} as SafeStorage)
  const item=await addVaultItem({kind:'login',label:'Fixture',origin:'https://example.test',values:{username:'fixture',password:'synthetic-only'}})
  const file=join(process.env.OPENBOT_DATA_DIR,'vault.json'),before=JSON.parse(await readFile(file,'utf8')).items[0].ciphertext
  await updateVaultItem(item.id,{label:'Renamed',values:{password:''}})
  assert.equal((await listVaultItems())[0].origin,'https://example.test')
  assert.equal(JSON.parse(await readFile(file,'utf8')).items[0].ciphertext,before)
  await Promise.all([updateVaultItem(item.id,{label:'Renamed',origin:'https://example.test',values:{password:'replacement'}}),addVaultItem({kind:'address',label:'Second',values:{city:'synthetic-city'}})])
  assert.equal((await listVaultItems()).length,2)
  assert.equal(await useVaultField(item.id,'username',async(_o,v)=>v==='fixture'),true)
  assert.equal(await useVaultField(item.id,'password',async(_o,v)=>v==='replacement'),true)
  assert.equal(JSON.stringify(await listVaultItems()).includes('replacement'),false)
  await assert.rejects(updateVaultItem(item.id,{label:' ',values:{}}))
  await assert.rejects(updateVaultItem('missing',{label:'Unknown'}))
})
