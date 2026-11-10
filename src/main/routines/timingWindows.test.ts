import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cronDueWindow, cronMatches, isValidScheduleOptions, onceDueWindow, parseCron } from './cron.ts'

test('once uses its precise occurrence within the current minute, explicit grace and no replay watermark', () => {
  const at = Date.UTC(2026, 10, 7, 10, 30, 20)
  assert.equal(onceDueWindow(at, undefined, at - 1), 'pending')
  assert.equal(onceDueWindow(at, undefined, at), 'due')
  assert.equal(onceDueWindow(at, undefined, at + 39_999), 'due')
  assert.equal(onceDueWindow(at, undefined, at + 40_000), 'missed')
  assert.equal(onceDueWindow(at, undefined, at + 40_000, 1), 'due')
  assert.equal(onceDueWindow(at, undefined, at + 100_000, 1), 'missed')
  assert.equal(onceDueWindow(at, at, at + 1), 'claimed')
})

test('timezones and DST use actual UTC occurrences, no invented nonexistent local time', () => {
  const cron = parseCron('30 1 * * *')!
  assert.equal(cronMatches(cron, new Date('2026-11-01T05:30:00Z'), 'America/New_York'), true)
  assert.equal(cronMatches(cron, new Date('2026-11-01T06:30:00Z'), 'America/New_York'), true)
  assert.equal(cronMatches(cron, new Date('2026-11-01T07:30:00Z'), 'America/New_York'), false)
  assert.equal(cronMatches(parseCron('30 2 * * *')!, new Date('2026-03-08T07:30:00Z'), 'America/New_York'), false)
  assert.equal(cronMatches(parseCron('0 18 * * *')!, new Date('2026-11-07T10:00:00Z'), 'Asia/Singapore'), true)
  assert.equal(isValidScheduleOptions({ tz: 'not/a/timezone' }), false)
  assert.equal(isValidScheduleOptions({ lateMinutes: -1 }), false)
})

test('default window stays current-minute; explicit early and late use planned identity', () => {
  const at = Date.UTC(2026, 10, 7, 10, 30)
  assert.equal(cronDueWindow('30 10 * * *', at - 60_000, at - 1, { tz: 'UTC' }).scheduledAt, undefined)
  assert.equal(cronDueWindow('30 10 * * *', at - 60_000, at - 1, { tz: 'UTC', earlyMinutes: 1 }).scheduledAt, at)
  assert.equal(cronDueWindow('30 10 * * *', at - 60_000, at + 60_000, { tz: 'UTC' }).missed?.count, 1)
  assert.equal(cronDueWindow('30 10 * * *', at - 60_000, at + 60_000, { tz: 'UTC', lateMinutes: 1 }).scheduledAt, at)
  assert.equal(cronDueWindow('30 10 * * *', at, at + 60_000, { tz: 'UTC', lateMinutes: 1 }).scheduledAt, undefined)
})
