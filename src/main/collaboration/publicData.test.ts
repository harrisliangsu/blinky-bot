import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SafeStorage } from 'electron'
import { publicRemoteData, preserveRedactedPatch } from './publicData.ts'
import { addVaultItem, setVaultStorageForTests } from '../store/vault.ts'

test('public workspace projection excludes private messages and fields, scrubs nested prose, and preserves hidden settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-public-')), before = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  setVaultStorageForTests({ isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: value => value.toString() } as SafeStorage)
  try {
    const secret = 'synthetic-private-literal-62418'
    await addVaultItem({ kind: 'login', label: 'Synthetic', values: { password: secret } })
    const input = { id: 'stable-id', name: 'Name ' + secret, tags: [secret], cwd: '/synthetic/' + secret, path: '/synthetic/' + secret + '/file.txt', config: { env: { SECRET: secret }, headers: { Authorization: secret }, password: secret }, messages: [
      { id: 'u', role: 'user', content: 'Visible ' + secret, createdAt: 1 },
      { id: 't', role: 'tool', content: 'PRIVATE_TOOL', createdAt: 1 },
      { id: 'a', role: 'assistant', content: 'PRIVATE_RAW', toolCalls: [{ name: 'shell' }], createdAt: 1 },
      { id: 'h', role: 'assistant', content: 'PRIVATE_INTERNAL', internal: true, createdAt: 1 }
    ] }
    const output = publicRemoteData(input)
    assert.equal(output.id, input.id)
    assert.equal(output.messages.length, 1)
    assert.ok(!JSON.stringify(output).includes(secret)); assert.ok(!JSON.stringify(output).includes('PRIVATE_'))
    assert.deepEqual(output.config, {})
    assert.deepEqual(preserveRedactedPatch(input, { name: output.name }), {})
    await writeFile(join(root, 'vault.json'), '{corrupt')
    assert.throws(() => publicRemoteData(input), /nothing was returned/)
  } finally { setVaultStorageForTests(undefined); if (before === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = before; await rm(root, { recursive: true, force: true }) }
})
