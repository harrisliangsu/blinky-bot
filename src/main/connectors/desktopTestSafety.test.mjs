import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { promisify } from 'node:util'
import { test } from 'node:test'
import './testNetworkGuard.mjs'

test('CLI checks refuse desktop process launches before touching any real executable', () => {
  // Deliberately nonexistent fixtures: even if protection regresses these
  // paths cannot start an app. No actual Electron binary is invoked.
  const absent = '/__blinky_nonexistent_test__/Electron.app/Contents/MacOS/Electron'
  for (const name of ['spawn','spawnSync','execFile','execFileSync']) assert.throws(() => childProcess[name](absent, []), /DESKTOP_TEST_DISABLED/)
  assert.throws(() => promisify(childProcess.execFile)(absent, []), /DESKTOP_TEST_DISABLED/)
  assert.throws(() => childProcess.exec('electron /__blinky_nonexistent_test__/fixture'), /DESKTOP_TEST_DISABLED/)
  assert.throws(() => childProcess.fork('/__blinky_nonexistent_test__/fixture', [], { execPath: absent }), /DESKTOP_TEST_DISABLED/)
})
