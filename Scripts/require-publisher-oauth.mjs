// Refuse to package a Mac app when a required publisher OAuth client is missing.
// Prints variable names only. Never prints values from the environment or env files.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REQUIRED = [
  'MAIN_VITE_GOOGLE_CLIENT_ID',
  'MAIN_VITE_X_CLIENT_ID',
  'MAIN_VITE_GITHUB_CLIENT_ID',
  'MAIN_VITE_GITHUB_CLIENT_SECRET',
]

function readEnvFile(file, into) {
  let text
  try { text = readFileSync(file, 'utf8') } catch { return }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!key.startsWith('MAIN_VITE_')) continue
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    into[key] = value
  }
}

const fromFiles = {}
const root = process.cwd()
// Same order electron-vite uses for a production build. Later files win.
for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) readEnvFile(resolve(root, name), fromFiles)

function resolved(name) {
  // Match Vite: a variable already in the environment wins, including an empty one.
  if (Object.prototype.hasOwnProperty.call(process.env, name)) return (process.env[name] ?? '').trim()
  return (fromFiles[name] ?? '').trim()
}

const missing = REQUIRED.filter((name) => !resolved(name))
if (missing.length) {
  console.error('Refusing to package BlinkyBot without publisher OAuth clients.')
  console.error('Set these build environment variables. Values are not printed:')
  for (const name of missing) console.error(`- ${name}`)
  console.error('MAIN_VITE_GOOGLE_CLIENT_SECRET is optional and is used only when the Google Desktop client requires it.')
  console.error('Put values in the environment or an untracked .env.local file. Do not commit them.')
  process.exit(1)
}
