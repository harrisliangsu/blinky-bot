import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acceptSlackEvent, markSlackQueued, parseSlackEvent, pendingSlackEvents } from './slackInboxStore.ts'
import type { SlackCredentials } from './slackSecrets.ts'

test('Slack events are scoped, persisted before acknowledgment, and deduplicated', async () => {
  const root=await mkdtemp(join(tmpdir(),'blinky-slack-inbox-'));process.env.OPENBOT_DATA_DIR=root
  const config:SlackCredentials={appToken:'xapp-fixture-token',botToken:'xoxb-fixture-token',teamId:'T123',botUserId:'UBOT',allowedUserId:'U123',channelId:'C123',botId:'blinky'}
  const payload={type:'event_callback',team_id:'T123',event_id:'Ev123',event:{type:'message',user:'U123',channel:'C123',ts:'123.456',text:'Check status'}}
  try{
    assert.equal(parseSlackEvent(config,{...payload,team_id:'TOTHER'}),null)
    assert.equal(parseSlackEvent(config,{...payload,event:{...payload.event,user:'UOTHER'}}),null)
    assert.equal(parseSlackEvent(config,{...payload,event:{...payload.event,channel:'COTHER'}}),null)
    assert.equal(parseSlackEvent(config,{...payload,event:{...payload.event,bot_id:'B1'}}),null)
    assert.equal(parseSlackEvent(config,{...payload,event:{...payload.event,subtype:'message_changed'}}),null)
    const first = acceptSlackEvent(config,payload)
    await assert.rejects(acceptSlackEvent(config,{...payload,event:{...payload.event,text:'conflicting concurrent payload'}}),/conflicts/)
    const [one,two]=await Promise.all([first,acceptSlackEvent(config,payload)])
    assert.equal(one?.id,two?.id);assert.equal((await pendingSlackEvents()).length,1)
    const saved=JSON.parse(await readFile(join(root,'slack-inbox',`${one!.id}.json`),'utf8'));assert.equal(saved.status,'pending')
    await assert.rejects(acceptSlackEvent(config,{...payload,event:{...payload.event,text:'changed'}}),/conflicts/)
    await markSlackQueued(one!.id,'session');assert.equal((await pendingSlackEvents()).length,0)
    assert.equal((await acceptSlackEvent(config,payload))?.status,'queued')
  }finally{await rm(root,{recursive:true,force:true})}
})
