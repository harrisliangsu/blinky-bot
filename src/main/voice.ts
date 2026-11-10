/** Native on-device speech. No audio crosses IPC, is saved, or goes to a provider. */
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, systemPreferences, type WebContents } from 'electron'
app.on('before-quit', () => { for (const run of [...active.values()]) run.cancel() })
import type { VoiceEvent, VoiceReply, VoiceStatus } from '../shared/voice'

const channel = 'openbot:voice:event'
const active = new Map<number, { id: string; child: ChildProcessWithoutNullStreams; cancel: () => void }>()
function helper(): string { return app.isPackaged ? join(process.resourcesPath, 'speech/BlinkySpeech') : join(app.getAppPath(), 'out/native/BlinkySpeech') }
export function voiceLanguage(value: unknown): string {
  if (typeof value !== 'string' || value === 'system') return app.getLocale()
  try { return new Intl.Locale(value.replaceAll('_', '-')).baseName } catch { return app.getLocale() }
}
export async function voiceStatus(language: unknown): Promise<VoiceStatus> {
  const locale = voiceLanguage(language)
  if (process.platform !== 'darwin' || !existsSync(helper())) return { speech: 'unavailable', microphone: 'unknown', onDevice: false, language: locale, failure: 'helper-unavailable' }
  const microphone = systemPreferences.getMediaAccessStatus('microphone')
  return new Promise((resolve) => execFile(helper(), ['status', locale], { timeout: 8000, killSignal: 'SIGKILL', maxBuffer: 10000 }, (error, stdout) => {
    try { if (error) throw error; const line = stdout.trim().split('\n').findLast(row => row.startsWith('{')); if (!line) throw new Error('No status'); resolve({ ...JSON.parse(line) as VoiceStatus, microphone }) }
    catch { resolve({ speech: 'unavailable', microphone, onDevice: false, language: locale, failure: 'helper-unavailable' }) }
  }))
}
export function startVoice(sender: WebContents, id: unknown, language: unknown): VoiceReply {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) return { ok: false, error: 'unavailable' }
  if (active.has(sender.id)) return { ok: false, error: 'busy' }
  if (process.platform !== 'darwin' || !existsSync(helper())) return { ok: false, error: 'helper-unavailable' }
  const child = spawn(helper(), ['start', voiceLanguage(language)], { stdio: ['pipe', 'pipe', 'pipe'] })
  let pending = '', ended = false, receivedResult = false
  const send = (event: Omit<VoiceEvent, 'id'>): void => { if (!sender.isDestroyed()) sender.send(channel, { ...event, id } satisfies VoiceEvent) }
  const cleanup = (): void => { sender.removeListener('destroyed', cancel); if (active.get(sender.id)?.id === id) active.delete(sender.id); clearTimeout(deadline) }
  const end = (error?: VoiceEvent['code']): void => {
    if (ended) return; ended = true
    if (error) send({ type: 'error', code: error })
    send({ type: 'end' }); cleanup()
  }
  const cancel = (): void => { end(); child.stdin.end('cancel\n'); child.kill('SIGTERM') }
  const deadline = setTimeout(() => { end('recognition'); child.kill('SIGTERM') }, 195000)
  active.set(sender.id, { id, child, cancel })
  sender.once('destroyed', cancel)
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    pending += chunk
    if (pending.length > 100000) { end('recognition'); child.kill('SIGTERM'); return }
    let newline: number
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
      if (ended) continue
      try {
        const event = JSON.parse(line) as VoiceEvent
        if (!['listening', 'stopping', 'interim', 'result', 'error', 'end'].includes(event.type)) continue
        if (event.type === 'end') { end(); continue }
        if (event.type === 'result') { if (receivedResult) continue; receivedResult = true }
        send({ type: event.type, ...(typeof event.text === 'string' ? { text: event.text.slice(0, 30000) } : {}), ...(event.code ? { code: event.code } : {}) })
      } catch { end('recognition'); child.kill('SIGTERM') }
    }
  })
  // Drain stderr, but never persist audio or native result text in logs.
  child.stderr.resume()
  child.on('error', () => end('helper-unavailable'))
  child.on('close', () => end(ended ? undefined : 'recognition'))
  send({ type: 'starting' })
  return { ok: true }
}
export function controlVoice(sender: WebContents, id: unknown, cancel: boolean): void {
  const run = active.get(sender.id)
  if (!run || run.id !== id) return
  if (cancel) run.cancel()
  else run.child.stdin.write('stop\n')
}
