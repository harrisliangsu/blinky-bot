import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { which } from '../backends/which.ts'
import { githubIssueFingerprint } from './githubWatch.ts'
import { setGitHubEnabled } from './githubConnection.ts'

test('GitHub connector calls only the fixture CLI and disconnect prevents further calls', async () => {
  // Run through runConnectionTests.mjs, which supplies an empty HOME/config and
  // an isolated login shell. Refuse the test before discovering any real CLI.
  assert.match(process.env.HOME ?? '', /blinky-connector-suite-.*\/home$/)
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'SSH_AUTH_SOCK']) assert.equal(process.env[key], undefined)
  const root = await mkdtemp(join(tmpdir(), 'github-fixture-'))
  const oldData = process.env.OPENBOT_DATA_DIR, binary = join(process.env.HOME!, '..', 'bin', 'gh')
  process.env.OPENBOT_DATA_DIR = root
  const trace = join(root, 'calls.jsonl')
  // This executable contains no HTTP client or shell command execution.
  await writeFile(binary, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);if(JSON.stringify(args)!==JSON.stringify(['api','--hostname','github.com','repos/fixture/repo/issues/7']))process.exit(2);fs.appendFileSync(${JSON.stringify(trace)},'fixture-read\\n');console.log(JSON.stringify({number:7,url:'https://api.github.com/repos/fixture/repo/issues/7',updated_at:'2026-11-06T00:00:00Z',state:'open',title:'Fixture',body:'Synthetic fixture',comments:0}));\n`, { mode: 0o700 })
  try {
    assert.equal(await which('gh'), binary)
    const first = await githubIssueFingerprint('fixture', 'repo', 7)
    assert.match(first, /^[a-f0-9]{64}$/)
    assert.equal(await githubIssueFingerprint('fixture', 'repo', 7), first)
    await setGitHubEnabled(false)
    await assert.rejects(githubIssueFingerprint('fixture', 'repo', 7), /disconnected/)
    assert.equal((await readFile(trace, 'utf8')).trim().split('\n').length, 2)
    assert.equal(JSON.parse(await readFile(join(root, 'github-connection.json'), 'utf8')).enabled, false)
  } finally {
    if (oldData === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = oldData
    await rm(root, { recursive: true, force: true })
    await rm(binary, { force: true })
  }
})
