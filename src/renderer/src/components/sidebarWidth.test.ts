import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clampSidebarWidth, readSidebarWidth, saveSidebarWidth, sidebarMaxWidth, SIDEBAR_WIDTH_STORAGE_KEY } from './sidebarWidth.ts'

test('sidebar respects bounds and leaves room for chat', () => {
  assert.equal(clampSidebarWidth(20, 1200), 100)
  assert.equal(clampSidebarWidth(80, 1200), 100)
  assert.equal(clampSidebarWidth(110, 1200), 110)
  assert.equal(clampSidebarWidth(900, 1200), 480)
  assert.equal(sidebarMaxWidth(920), 460)
  assert.equal(clampSidebarWidth(480, 920), 460)
  assert.equal(clampSidebarWidth(480, 1200), 480)
})

test('sidebar keeps a valid saved preference and survives storage failures', () => {
  let saved: string | null = '420'
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: {
      getItem: (key: string) => key === SIDEBAR_WIDTH_STORAGE_KEY ? saved : null,
      setItem: (key: string, value: string) => { assert.equal(key, SIDEBAR_WIDTH_STORAGE_KEY); saved = value }
    } }
  })
  try {
    assert.equal(readSidebarWidth(), 420)
    saveSidebarWidth(340)
    assert.equal(readSidebarWidth(), 340)
    saved = 'not-a-number'
    assert.equal(readSidebarWidth(), 272)
    saved = '900'
    assert.equal(readSidebarWidth(), 480)
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { get localStorage() { throw new Error('denied') } } })
    assert.equal(readSidebarWidth(), 272)
    assert.doesNotThrow(() => saveSidebarWidth(340))
  } finally {
    Reflect.deleteProperty(globalThis, 'window')
  }
})
