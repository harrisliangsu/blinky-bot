import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  addPermission,
  initialPermissionIds,
  permissionById,
  readPermissionList,
  removePermission,
  statusForPermission,
  statusLabel,
  visiblePermissionIds,
  writePermissionList
} from './systemPermissions.ts'

test('default system permissions are the ones this app already uses', () => {
  const ids = initialPermissionIds()
  assert.ok(ids.includes('screen-recording'))
  assert.ok(ids.includes('accessibility'))
  assert.ok(ids.includes('automation'))
  assert.ok(ids.includes('microphone'))
  assert.ok(ids.includes('notifications'))
  assert.equal(ids.includes('camera'), false)
  assert.equal(ids.includes('full-disk-access'), false)
  assert.equal(ids.includes('input-monitoring'), false)
})

test('every catalog entry opens a System Settings deep link', () => {
  const screen = permissionById('screen-recording')
  assert.ok(screen)
  assert.match(screen.url, /^x-apple\.systempreferences:/)
  assert.match(screen.url, /Privacy_ScreenCapture/)
  assert.match(permissionById('notifications')!.url, /Notifications-Settings/)
  assert.match(permissionById('accessibility')!.url, /Privacy_Accessibility/)
  assert.match(permissionById('microphone')!.url, /Privacy_Microphone/)
  assert.match(permissionById('local-network')!.url, /Privacy_LocalNetwork/)
  for (const id of ['input-monitoring', 'camera', 'automation', 'full-disk-access', 'files-and-folders'] as const) {
    assert.match(permissionById(id)!.url, /^x-apple\.systempreferences:/)
  }
})

test('adding and removing only changes the managed list', () => {
  const added = addPermission({ hidden: [], added: [] }, 'camera')
  assert.deepEqual(visiblePermissionIds(added).includes('camera'), true)
  assert.equal(visiblePermissionIds(added).includes('screen-recording'), true)
  const hidden = removePermission(added, 'camera')
  assert.equal(visiblePermissionIds(hidden).includes('camera'), false)
  const droppedDefault = removePermission({ hidden: [], added: [] }, 'screen-recording')
  assert.equal(visiblePermissionIds(droppedDefault).includes('screen-recording'), false)
  assert.equal(addPermission({ hidden: [], added: [] }, 'not-a-permission').added.length, 0)
})

test('status labels follow the probe and are not assumed granted', () => {
  assert.equal(statusLabel('granted', true), '已授权')
  assert.equal(statusLabel('denied', true), '未授权')
  assert.equal(statusLabel('not-determined', true), '未确定')
  assert.equal(statusLabel('unknown', true), '未知')
  assert.equal(statusForPermission('screen-recording', { media: () => 'denied' }), 'denied')
  assert.equal(statusForPermission('screen-recording', { media: () => 'not-determined' }), 'not-determined')
  assert.equal(statusForPermission('microphone', {}), 'unknown')
  assert.equal(statusForPermission('accessibility', { accessibility: false }), 'denied')
  assert.equal(statusForPermission('accessibility', { accessibility: true }), 'granted')
  assert.equal(statusForPermission('notifications', { media: () => 'granted' }), 'unknown')
  assert.equal(statusForPermission('full-disk-access', { fullDisk: 'unknown' }), 'unknown')
})

test('a saved list round-trips and drops unknown ids', () => {
  const memory = new Map<string, string>()
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value) }
  }
  writePermissionList(storage, { hidden: ['microphone', 'nope'], added: ['camera', 'nope'] })
  assert.deepEqual(readPermissionList(storage), { hidden: ['microphone'], added: ['camera'] })
  assert.equal(readPermissionList({ getItem: () => '{' }).added.length, 0)
})
