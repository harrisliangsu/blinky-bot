import { createInterface } from 'node:readline'
import { NATIVE_CHANNELS, NATIVE_FRAME_PREFIX, dispatchNativeFrame, type NativeHandler } from './stdioProtocol'

const handlers = new Map<string, NativeHandler>()
let active = false

/** Register only normal IPC handlers. Event-sensitive handlers stay inaccessible. */
export function registerNativeHandler(channel: string, handler: NativeHandler): void {
  if (process.env.BLINKY_NATIVE_RUNTIME === '1' && NATIVE_CHANNELS.has(channel)) handlers.set(channel, handler)
}

function writeFrame(frame: unknown): void {
  if (active) process.stdout.write(`${NATIVE_FRAME_PREFIX}${JSON.stringify(frame)}\n`)
}

export function sendNativeEvent(event: unknown): void {
  writeFrame({ event })
}

/** Enabled only for a dedicated child process controlled over inherited pipes. */
export function startNativeBridge(onDisconnect: () => void): void {
  if (process.env.BLINKY_NATIVE_RUNTIME !== '1') return
  active = true
  let disconnected = false
  const disconnect = (): void => {
    if (disconnected) return
    disconnected = true
    active = false
    onDisconnect()
  }
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on('line', (line) => {
    void dispatchNativeFrame(line, handlers).then((response) => {
      if (active) process.stdout.write(`${NATIVE_FRAME_PREFIX}${response}\n`)
    })
  })
  input.on('close', disconnect)
  process.stdout.on('error', disconnect)
  writeFrame({ ready: true })
}
