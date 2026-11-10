import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultSettings } from '../settingsSchema.ts'
import { canonicalFolder, folderMetadataFingerprint } from './folderWatch.ts'

test('recursive metadata detects nested changes without opening files or child symlink destinations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-folder-metadata-'))
  try {
    const directory = join(root, 'watched'), outside = join(root, 'outside')
    await mkdir(join(directory, 'nested'), { recursive: true }); await mkdir(outside)
    await writeFile(join(directory, 'nested', 'opaque'), 'synthetic fixture')
    await chmod(join(directory, 'nested', 'opaque'), 0)
    await chmod(outside, 0)
    await symlink(outside, join(directory, 'external'))
    const path = await canonicalFolder(directory), before = await folderMetadataFingerprint(path)
    await chmod(join(directory, 'nested', 'opaque'), 0o600)
    await writeFile(join(directory, 'nested', 'opaque'), 'changed synthetic fixture')
    const changed = await folderMetadataFingerprint(path)
    assert.notEqual(changed, before)
    await rename(join(directory, 'nested', 'opaque'), join(directory, 'nested', 'renamed'))
    assert.notEqual(await folderMetadataFingerprint(path), changed)
    await symlink(directory, join(root, 'approved-alias'))
    assert.equal(await canonicalFolder(join(root, 'approved-alias')), path)
    await assert.rejects(folderMetadataFingerprint(path, { maxEntries: 1 }), /超过/)
    await assert.rejects(folderMetadataFingerprint(path, { maxDepth: 0 }), /超过/)
    await assert.rejects(folderMetadataFingerprint(path, { settings: { ...defaultSettings(), denylist: [join(path, 'nested')] } }), /限制拒绝/)
    await assert.rejects(folderMetadataFingerprint(path, { settings: { ...defaultSettings(), localExecutionPolicy: 'never-allow' } }), /Never allow/)
    await assert.rejects(folderMetadataFingerprint('/does-not-exist', { settings: { ...defaultSettings(), localExecutionPolicy: 'ask-every-time', allowlist: ['*'] } }), /unattended scans are paused/)
    await assert.rejects(folderMetadataFingerprint(path, { settings: { ...defaultSettings(), asklist: ['tool:list_dir'] } }), /unattended scans are paused/)
    let checks = 0
    await assert.rejects(folderMetadataFingerprint(path, { getSettings: () => ({ ...defaultSettings(), localExecutionPolicy: ++checks > 2 ? 'never-allow' : 'always-allow' }) }), /Never allow/)
    await rm(join(directory, 'external')); await chmod(outside, 0o700)
    await rm(directory, { recursive: true }); await symlink(outside, directory)
    await assert.rejects(folderMetadataFingerprint(path), /物理路径已改变/)
  } finally { await chmod(join(root, 'outside'), 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }) }
})
