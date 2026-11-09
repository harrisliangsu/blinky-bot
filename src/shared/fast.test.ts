import assert from 'node:assert/strict'
import {test} from 'node:test'
import {fastModelVariant, fastServiceTier, fastWire, modelAcceptsFast} from './fast'

test('the fast switch only appears for providers with a real fast lane',()=>{
 assert.equal(fastWire('openai'),'openai')
 assert.equal(fastWire('openrouter'),'openrouter')
 assert.equal(fastWire('codex'),null)
 assert.equal(fastWire('kimi'),null)
 assert.equal(fastWire('anthropic'),null)
 assert.equal(fastWire('xai'),null)
})

test('openrouter routes the nitro suffix only when fast is on and the model is usable',()=>{
 assert.equal(fastModelVariant('openrouter','gpt-5',true),'gpt-5:nitro')
 assert.equal(fastModelVariant('openrouter','gpt-5:nitro',true),'gpt-5:nitro')
 assert.equal(fastModelVariant('openrouter','gpt-5',false),'gpt-5')
 assert.equal(modelAcceptsFast('openrouter','default'),false)
 assert.equal(modelAcceptsFast('openrouter','  '),false)
 assert.equal(modelAcceptsFast('openrouter','anything'),true)
})

test('openai maps fast to the priority service tier only for models that accept the tier',()=>{
 assert.deepEqual(fastServiceTier('openai','gpt-5',true),{service_tier:'priority'})
 assert.equal(fastServiceTier('openai','gpt-5',false),undefined)
 assert.equal(fastServiceTier('openai','default',true),undefined)
 assert.equal(fastServiceTier('openrouter','gpt-5',true),undefined)
 // The model id itself never changes on the OpenAI wire.
 assert.equal(fastModelVariant('openai','gpt-5',true),'gpt-5')
})

test('a provider without a fast lane never maps or accepts anything',()=>{
 assert.equal(modelAcceptsFast('codex','gpt-5'),false)
 assert.equal(fastModelVariant('codex','gpt-5',true),'gpt-5')
 assert.equal(fastServiceTier('codex','gpt-5',true),undefined)
})
