import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const script = join(process.cwd(), 'Scripts/require-publisher-oauth.mjs')
const ids = {
  MAIN_VITE_GOOGLE_CLIENT_ID: 'fixture-google-id',
  MAIN_VITE_X_CLIENT_ID: 'fixture-x-id',
  MAIN_VITE_GITHUB_CLIENT_ID: 'fixture-github-id',
  MAIN_VITE_GITHUB_CLIENT_SECRET: 'fixture-github-secret',
}

function run(cwd, env = {}) {
  return spawnSync(process.execPath, [script], { cwd, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' })
}

test('packaging names the missing publisher clients and does not print values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-oauth-env-'))
  try {
    const absent = run(root)
    assert.notEqual(absent.status, 0)
    for (const name of Object.keys(ids)) assert.match(absent.stderr, new RegExp(name))
    assert.equal(absent.stdout, '')
    for (const value of Object.values(ids)) assert.equal(absent.stderr.includes(value), false)

    await writeFile(join(root, '.env.local'), `${Object.entries(ids).map(([key, value]) => `${key}=${value}`).join('\n')}\n`)
    const fromFile = run(root, { MAIN_VITE_GOOGLE_CLIENT_SECRET: '' })
    assert.equal(fromFile.status, 0, fromFile.stderr)
    const output = `${fromFile.stdout}\n${fromFile.stderr}`
    for (const value of Object.values(ids)) assert.equal(output.includes(value), false)

    const missingSecret = run(root, { MAIN_VITE_GITHUB_CLIENT_SECRET: '' })
    assert.notEqual(missingSecret.status, 0)
    assert.match(missingSecret.stderr, /MAIN_VITE_GITHUB_CLIENT_SECRET/)
    assert.equal(missingSecret.stderr.includes(ids.MAIN_VITE_GITHUB_CLIENT_ID), false)
    assert.equal(missingSecret.stderr.includes(ids.MAIN_VITE_GITHUB_CLIENT_SECRET), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
