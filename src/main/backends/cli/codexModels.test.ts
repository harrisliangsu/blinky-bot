import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCodexModelPage } from './codexModelList.ts'

test('model/list becomes picker rows and skips hidden and unsafe ids', () => {
  const page = parseCodexModelPage({
    data: [
      {
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'GPT-5.4',
        hidden: false,
        inputModalities: ['text', 'image'],
        isDefault: true
      },
      {
        id: 'text-only',
        model: 'text-only',
        displayName: 'Text only',
        inputModalities: ['text']
      },
      { id: 'secret', model: 'secret', displayName: 'Secret', hidden: true },
      { id: 'bad id', model: 'bad id', displayName: 'Bad' },
      { model: 'default', displayName: 'Default' }
    ],
    nextCursor: 'page-2'
  })
  assert.deepEqual(
    page.models.map((model) => [model.id, model.label, model.supportsVision]),
    [
      ['gpt-5.4', 'GPT-5.4', true],
      ['text-only', 'Text only', false]
    ]
  )
  assert.equal(page.nextCursor, 'page-2')
})

test('a missing modality list is treated as vision-capable', () => {
  const page = parseCodexModelPage({
    data: [{ id: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex' }]
  })
  assert.equal(page.models[0]?.supportsVision, true)
  assert.equal(page.nextCursor, null)
})

test('an unreadable page does not invent a cursor', () => {
  assert.deepEqual(parseCodexModelPage(null), { models: [], nextCursor: null })
  assert.equal(parseCodexModelPage({ data: [], nextCursor: 'has\nnewline' }).nextCursor, null)
})

test('reasoning levels come from each model and preserve max and ultra', () => {
  const page = parseCodexModelPage({ data: [
    { id: 'a', supportedReasoningEfforts: [
      { reasoningEffort: 'low' }, { reasoningEffort: 'max' },
      { reasoningEffort: 'ultra' }, { reasoningEffort: 'none' },
      { reasoningEffort: 'ultra' }, { reasoningEffort: 'unrecognized' }
    ] },
    { id: 'b', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    { id: 'legacy' }, { id: 'no-thinking', supportedReasoningEfforts: [] }
  ] })
  assert.deepEqual(page.models.map((model) => model.supportedThinking), [
    ['low', 'max', 'ultra', 'off'], ['high'], undefined, []
  ])
})
