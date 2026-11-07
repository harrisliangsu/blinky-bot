import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SafeStorage } from 'electron'
import { addVaultItem, listVaultItems, removeVaultItem, scrubVaultText, setVaultStorageForTests, useVaultField, vaultItemId, vaultItemRef } from './vault.ts'

test('vault writes encrypted values, returns only metadata and refuses damaged storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-vault-'))
  const previous = process.env['OPENBOT_DATA_DIR'], key = randomBytes(32)
  const fake = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => { const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv), encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]); return Buffer.concat([iv,cipher.getAuthTag(),encrypted]) },
    decryptString: (value: Buffer) => { const decipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAuthTag(value.subarray(12,28));return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString('utf8') }
  } as SafeStorage
  try {
    process.env['OPENBOT_DATA_DIR'] = root
    setVaultStorageForTests(fake)
    const secret = 'fixture-only-secret-7319'
    const [first, second] = await Promise.all([
      addVaultItem({ kind: 'login', label: 'Example', origin: 'https://example.com/path', values: { username: 'fixture-user', password: secret } }),
      addVaultItem({ kind: 'address', label: 'Home', values: { city: 'fixture-city' } })
    ])
    assert.equal(first.origin, 'https://example.com')
    assert.equal((await listVaultItems()).length, 2)
    assert.ok(!JSON.stringify(await listVaultItems()).includes(secret))
    const raw = await readFile(join(root, 'vault.json'), 'utf8')
    assert.ok(!raw.includes(secret))
    const record = JSON.parse(raw).items.find((item: { metadata: VaultItem }) => item.metadata.id === first.id)
    assert.equal(JSON.parse(fake.decryptString(Buffer.from(record.ciphertext, 'base64'))).password, secret)
    assert.equal(await useVaultField(first.id, 'password', async (origin, value) => origin === 'https://example.com' && value === secret), true)
    const ref = vaultItemRef(first.id)
    assert.equal(vaultItemId(ref), first.id)
    assert.equal(await useVaultField(ref, 'password', async (_origin, value) => value === secret), true)
    assert.throws(() => vaultItemId(ref + '/password'), /Invalid vault reference/)
    assert.equal(await useVaultField(ref, 'password', async () => secret as unknown as boolean), false, 'adapter output cannot retrieve a value')
    await assert.rejects(useVaultField(ref, 'password', async () => { throw new Error(secret) }), (error: Error) => !error.message.includes(secret) && /could not be used/.test(error.message))
    const safe = await scrubVaultText(`tool output contains ${secret} and fixture-user; ref ${ref}`)
    assert.equal(safe.redacted, true); assert.equal(safe.unavailable, false)
    assert.ok(!safe.text.includes(secret)); assert.ok(!safe.text.includes('fixture-user')); assert.ok(safe.text.includes(ref))
    await assert.rejects(useVaultField(second.id, 'city', async () => true), /site is unavailable/)
    await assert.rejects(useVaultField(first.id, 'security_code', async () => true), /unavailable/)
    assert.equal(await removeVaultItem(second.id), true)
    assert.equal((await listVaultItems()).length, 1)
    setVaultStorageForTests(null)
    assert.deepEqual(await scrubVaultText(secret), { text: '[Content withheld: vault unavailable]', redacted: true, unavailable: true })
    await assert.rejects(addVaultItem({ kind: 'login', label: 'No encryption', values: { password: secret } }), /encryption is unavailable/)
    setVaultStorageForTests({ ...fake, getSelectedStorageBackend: () => 'basic_text' } as SafeStorage)
    await assert.rejects(addVaultItem({ kind: 'login', label: 'No keyring', values: { password: secret } }), /encryption is unavailable/)
    await writeFile(join(root, 'vault.json'), '{broken')
    setVaultStorageForTests(fake)
    await assert.rejects(addVaultItem({ kind: 'login', label: 'Damaged', values: { password: secret } }), /damaged/)
    assert.equal(await readFile(join(root, 'vault.json'), 'utf8'), '{broken')
  } finally {
    setVaultStorageForTests(undefined)
    if (previous === undefined) delete process.env['OPENBOT_DATA_DIR']; else process.env['OPENBOT_DATA_DIR'] = previous
    await rm(root, { recursive: true, force: true })
  }
})

interface VaultItem { id: string }
