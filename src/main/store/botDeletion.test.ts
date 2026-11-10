import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { rm, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBot, getBot, loadBots, removeBotDurable, retryBotRemoval, seedBotsIfEmpty, updateBot } from './bots.ts'
import { flushAll, writeJsonNow } from './jsonStore.ts'

const root = mkdtempSync(join(tmpdir(),'blinky-bot-deletion-'))
process.env['OPENBOT_DATA_DIR']=root

test('durable deletion cancels pending writes and survives reloading the bot store', async()=>{
  await loadBots()
  const bot=createBot({name:'Disposable',emoji:'🧪',color:'#123456',backendId:'codex',modelId:'default'})
  updateBot(bot.id,{description:'Pending write must not resurrect this Bot'})
  assert.equal(await removeBotDurable(bot.id),true)
  await flushAll()
  assert.equal(getBot(bot.id),null)
  assert.equal(existsSync(join(root,'bots',`${bot.id}.json`)),false)
  await loadBots()
  assert.equal(getBot(bot.id),null)
  assert.deepEqual(seedBotsIfEmpty(),[])
})

test('a failed disk deletion retains the live Bot and allows a retry',async()=>{
  const bot=createBot({name:'Keep on failure',backendId:'codex',modelId:'default'})
  await flushAll()
  const file=join(root,'bots',`${bot.id}.json`), saved=file+'.saved'
  await rename(file,saved);mkdirSync(file)
  await assert.rejects(removeBotDurable(bot.id),/could not be deleted/)
  assert.equal(getBot(bot.id)?.name,bot.name)
  await rm(file,{recursive:true});await rename(saved,file)
  assert.ok((await flushAll()).failed.includes(file))
  const unrelated=join(root,'unrelated.json');mkdirSync(unrelated)
  await assert.rejects(writeJsonNow(unrelated,{keep:true}))
  await retryBotRemoval(bot.id)
  assert.deepEqual((await flushAll()).failed,[unrelated])
  await rm(unrelated,{recursive:true});await writeJsonNow(unrelated,{keep:true})
  assert.deepEqual((await flushAll()).failed,[])
  assert.equal(await removeBotDurable(bot.id),true)
  assert.equal(getBot(bot.id),null)
  assert.deepEqual((await flushAll()).failed,[])
})
