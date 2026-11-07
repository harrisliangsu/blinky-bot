import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { removeSkillLinks, syncSkillLinks, type SkillSyncTarget } from './sync.ts'

test('skill sync preserves conflicts and removes only links it owns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-skill-sync-'))
  const shared = join(root, 'shared'), owned = join(root, 'owned'), conflict = join(root, 'conflict'), external = join(root, 'external'), skipped = join(root, 'skipped')
  try {
    await Promise.all([shared, owned, conflict, external].map((path) => mkdir(path, { recursive: true })))
    await mkdir(join(shared, 'demo'))
    await writeFile(join(shared, 'demo', 'SKILL.md'), 'demo')
    await mkdir(join(conflict, 'demo'))
    await writeFile(join(conflict, 'demo', 'SKILL.md'), 'user copy')
    await symlink(join(shared, 'demo'), join(external, 'demo'))
    const targets: SkillSyncTarget[] = [
      { agent: 'owned', dir: owned, enabled: true },
      { agent: 'conflict', dir: conflict, enabled: true },
      { agent: 'external', dir: external, enabled: true },
      { agent: 'skipped', dir: skipped, enabled: false }
    ]
    const results = await syncSkillLinks(shared, 'demo', targets)
    assert.deepEqual(results.map((item) => item.status), ['linked', 'conflict', 'existing', 'unavailable'])
    assert.equal(await readlink(join(owned, 'demo')), join(shared, 'demo'))
    assert.equal(await readFile(join(conflict, 'demo', 'SKILL.md'), 'utf8'), 'user copy')
    await assert.rejects(removeSkillLinks(shared, 'demo', targets), /unmanaged skill link/)
    assert.ok((await lstat(join(owned, 'demo'))).isSymbolicLink())
    await unlink(join(external, 'demo'))
    await unlink(join(owned, 'demo'))
    await symlink(conflict, join(owned, 'demo'))
    await removeSkillLinks(shared, 'demo', targets)
    assert.equal(await readlink(join(owned, 'demo')), conflict, 'a changed user link must survive uninstall')
    assert.equal(await readFile(join(conflict, 'demo', 'SKILL.md'), 'utf8'), 'user copy')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('damaged ownership metadata is not overwritten', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-skill-sync-'))
  try {
    const shared = join(root, 'shared'), metadata = join(shared, '.blinky-sync', 'demo.json')
    await mkdir(join(shared, '.blinky-sync'), { recursive: true })
    await writeFile(metadata, '{broken')
    await assert.rejects(syncSkillLinks(shared, 'demo', []), /damaged/)
    assert.equal(await readFile(metadata, 'utf8'), '{broken')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a lock held by another process prevents concurrent ownership changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-skill-sync-'))
  try {
    const shared = join(root, 'shared'), lock = join(shared, '.blinky-sync', 'demo.lock')
    await mkdir(lock, { recursive: true })
    await assert.rejects(syncSkillLinks(shared, 'demo', []), /already running/)
    assert.ok((await lstat(lock)).isDirectory())
  } finally { await rm(root, { recursive: true, force: true }) }
})
