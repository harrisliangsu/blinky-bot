#!/usr/bin/env node
// Timeline reader for the local telemetry database (events.sqlite).
// Metadata only — no message content is ever stored there.
//
//   node Scripts/inspect-events.mjs --session <id> [--last 60]
//   node Scripts/inspect-events.mjs --task <id>
//   node Scripts/inspect-events.mjs --kind turn.completed --last 30
//   node Scripts/inspect-events.mjs --stats
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import os from 'node:os'

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined }
const session = flag('session')
const task = flag('task')
const kind = flag('kind')
const lastMinutes = Number(flag('last') ?? 60)
const stats = args.includes('--stats')

const dataDir = process.env.OPENBOT_DATA_DIR || join(os.homedir(), 'Library/Application Support/BlinkyBot')
const db = new DatabaseSync(join(dataDir, 'events.sqlite'), { readOnly: true })
const since = Date.now() - lastMinutes * 60 * 1000

if (stats) {
  const rows = db.prepare(`SELECT kind, COUNT(*) AS n, AVG(duration_ms) AS avg_ms, MAX(at) AS latest FROM events GROUP BY kind ORDER BY n DESC`).all()
  console.log(JSON.stringify(rows, null, 2))
  process.exit(0)
}

const clauses = ['at >= ?'], params = [since]
if (session) { clauses.push('session_id = ?'); params.push(session) }
if (task) { clauses.push('task_id = ?'); params.push(task) }
if (kind) { clauses.push('kind = ?'); params.push(kind) }
const rows = db.prepare(`SELECT at, kind, session_id, bot_id, task_id, duration_ms, outcome, size FROM events WHERE ${clauses.join(' AND ')} ORDER BY seq ASC LIMIT 500`).all(...params)
for (const row of rows) {
  const time = new Date(row.at).toISOString().slice(11, 19)
  const parts = [time, row.kind]
  if (row.outcome) parts.push(`outcome=${row.outcome}`)
  if (row.duration_ms != null) parts.push(`${row.duration_ms}ms`)
  if (row.size != null) parts.push(`size=${row.size}`)
  if (row.session_id) parts.push(`session=${String(row.session_id).slice(0, 8)}`)
  if (row.task_id) parts.push(`task=${String(row.task_id).slice(0, 8)}`)
  console.log(parts.join('  '))
}
console.log(`-- ${rows.length} events`)
