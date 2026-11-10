import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { RecoveryFile } from './recoveryFile.ts'

test('only OS protected bytes are persisted and unreadable records fail closed without replacement', () => {
  const root = mkdtempSync(join(tmpdir(), 'blinky-sharing-recovery-')), file = join(root, 'recovery.json'), key = randomBytes(32)
  const protection = { isEncryptionAvailable: () => true,
    encryptString(s: string) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), body = Buffer.concat([cipher.update(s), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]) },
    decryptString(b: Buffer) { const decipher = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); decipher.setAuthTag(b.subarray(12, 28)); return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString() }
  }
  try {
    const store = new RecoveryFile(file, protection), value = { approved: 'synthetic-private-host-key', stopped: false }
    assert.equal(store.read(), null); store.write(value)
    assert.deepEqual(new RecoveryFile(file, protection).read(), value)
    assert.equal(readFileSync(file, 'utf8').includes(value.approved), false)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    for (const unavailable of [{ ...protection, isEncryptionAvailable: () => false }, { ...protection, getSelectedStorageBackend: () => 'basic_text' }]) {
      const disabled = new RecoveryFile(file, unavailable), before = readFileSync(file)
      assert.throws(() => disabled.read()); assert.throws(() => disabled.write({ stopped: true })); assert.deepEqual(readFileSync(file), before)
    }
    store.write({ stopped: true }); assert.deepEqual(store.read(), { stopped: true })
    writeFileSync(file, '{bad'); assert.throws(() => store.read()); assert.equal(readFileSync(file, 'utf8'), '{bad')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
