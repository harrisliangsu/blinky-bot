import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shortcutFor } from './shortcutRules.ts'

test('Command-N cannot create or reset a Bot conversation', () => {
  const intent = { key: 'n', mod: true, alt: false, repeat: false, editable: false, passesEscape: false }
  assert.equal(shortcutFor(intent, { approvals: 0, modalOpen: false, streaming: false }), null)
  assert.equal(shortcutFor(intent, { approvals: 1, modalOpen: false, streaming: true }), null)
})

test('an inline approval does not block the settings shortcut', () => {
  const intent = { key: ',', mod: true, alt: false, repeat: false, editable: false, passesEscape: false }
  assert.equal(shortcutFor(intent, { approvals: 0, modalOpen: false, streaming: false }), 'settings')
  assert.equal(shortcutFor(intent, { approvals: 1, modalOpen: false, streaming: true }), 'settings')
})

test('settings shortcut cannot replace an unsaved modal draft', () => {
  const intent = { key: ',', mod: true, alt: false, repeat: false, editable: true, passesEscape: false }
  assert.equal(shortcutFor(intent, { approvals: 0, modalOpen: true, streaming: false }), null)
})

test('Escape in the composer does not cancel a running turn or answer an approval', () => {
  const intent = { key: 'Escape', mod: false, alt: false, repeat: false, editable: true, passesEscape: false }
  assert.equal(shortcutFor(intent, { approvals: 1, modalOpen: false, streaming: true }), null)
})

test('sidebar shortcut works from the composer without stealing shifted, repeated or composing input', () => {
  const intent = { key: '\\', mod: true, alt: false, repeat: false, editable: true, passesEscape: false }
  const state = { approvals: 1, modalOpen: false, streaming: true }
  assert.equal(shortcutFor(intent, state), 'toggle-sidebar')
  assert.equal(shortcutFor({ ...intent, repeat: true }, state), null)
  assert.equal(shortcutFor({ ...intent, shift: true }, state), null)
  assert.equal(shortcutFor({ ...intent, composing: true }, state), null)
  assert.equal(shortcutFor(intent, { ...state, modalOpen: true }), null)
})

test('palette shortcut cannot replace a modal draft, but can dismiss its own palette', () => {
  const intent = { key: 'k', mod: true, alt: false, repeat: false, editable: true, passesEscape: false }
  const state = { approvals: 0, modalOpen: true, streaming: false }
  assert.equal(shortcutFor(intent, state), null)
  assert.equal(shortcutFor(intent, { ...state, paletteOpen: true }), 'toggle-palette')
  assert.equal(shortcutFor({ ...intent, shift: true }, { ...state, modalOpen: false }), null)
})
