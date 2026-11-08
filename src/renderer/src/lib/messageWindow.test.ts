import assert from 'node:assert/strict'
import {test} from 'node:test'
import {tailWindow,TRANSCRIPT_WINDOW,SNAPSHOT_WINDOW} from './messageWindow'

test('hundreds of private observations cannot evict real chat from transcript or pane windows',()=>{
 const publicMessages:{id:string;role:string;internal?:boolean;uiOnly?:boolean}[]=[{id:'goal',role:'user'},{id:'tool',role:'tool'},{id:'status',role:'assistant',uiOnly:true},{id:'milestone',role:'assistant'}]
 const messages=[...publicMessages,...Array.from({length:205},(_,i)=>({id:`private-${i}`,role:i%2?'assistant':'user',internal:true}))]
 const shown=tailWindow(messages,TRANSCRIPT_WINDOW,m=>!m.internal)
 assert.deepEqual(shown.visible,publicMessages);assert.equal(shown.hidden,0)
 const byId=new Map(messages.map(m=>[m.id,m]))
 const focused=tailWindow(messages.map(m=>m.id),SNAPSHOT_WINDOW,id=>!byId.get(id)?.internal)
 assert.deepEqual(focused.visible,publicMessages.map(m=>m.id));assert.equal(focused.hidden,0)
})

test('earlier counts and invalid-limit fallback apply to public entries without hiding tool or status rows',()=>{
 const messages=Array.from({length:45},(_,i)=>({id:`public-${i}`,internal:false})).flatMap(m=>[m,{id:'private-'+m.id,internal:true}])
 assert.equal(tailWindow(messages,40,m=>!m.internal).hidden,5)
 assert.equal(tailWindow(messages,40,m=>!m.internal).visible[0].id,'public-5')
 for(const limit of [0,NaN,Infinity])assert.equal(tailWindow(messages,limit,m=>!m.internal).visible.length,45)
 assert.equal(tailWindow(messages,40).visible.length,40)
})
