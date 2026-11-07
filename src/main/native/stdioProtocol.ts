/**
 * Private parent/child protocol for the SwiftUI migration. Only messages sent
 * over the runtime child's inherited stdin reach this dispatcher; it opens no
 * TCP or filesystem socket. The allowlist deliberately excludes window and
 * operating-system controls and can grow only with their native UI.
 */

export const NATIVE_FRAME_PREFIX = '@@BLINKY_NATIVE@@'
// A screenshot can use up to 7.5 MB of base64; leave room for two and text.
const MAX_FRAME = 16 * 1024 * 1024
export const NATIVE_CHANNELS = new Set([
  'openbot:bots:list',
  'openbot:bots:create',
  'openbot:bots:remove',
  'openbot:bots:update',
  'openbot:bots:memory',
  'openbot:bots:addMemory',
  'openbot:bots:removeMemory',
  'openbot:sessions:get',
  'openbot:sessions:create',
  'openbot:agent:isRunning',
  'openbot:agent:enqueue',
  'openbot:agent:queue',
  'openbot:agent:pauseQueue',
  'openbot:agent:removeQueued',
  'openbot:agent:stop',
  'openbot:agent:respondToApproval',
  'openbot:backends:list',
  'openbot:backends:refresh',
  'openbot:settings:get',
  'openbot:settings:update',
  'native:catalog:providers'
])

export type NativeHandler = (args: unknown[]) => unknown | Promise<unknown>

export async function dispatchNativeFrame(
  line: string,
  handlers: ReadonlyMap<string, NativeHandler>
): Promise<string> {
  let id: unknown
  try {
    if (Buffer.byteLength(line, 'utf8') > MAX_FRAME) throw new Error('Request too large')
    const request: unknown = JSON.parse(line)
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid request')
    const frame = request as Record<string, unknown>
    id = frame['id']
    if (typeof id !== 'string' || id.length > 128 || !id) throw new Error('Invalid request id')
    if (typeof frame['channel'] !== 'string' || !NATIVE_CHANNELS.has(frame['channel'])) throw new Error('Unsupported channel')
    if (!Array.isArray(frame['args'])) throw new Error('Invalid arguments')
    const handler = handlers.get(frame['channel'])
    if (!handler) throw new Error('Channel unavailable')
    const result = await handler(frame['args'])
    return JSON.stringify({ id, result: result ?? null })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed'
    return JSON.stringify({ id: typeof id === 'string' ? id : null, error: message })
  }
}
