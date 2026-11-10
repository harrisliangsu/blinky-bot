import { remoteChannelPolicies } from '../../shared/remoteCapabilities'

type Handler = (args: unknown[]) => unknown | Promise<unknown>
const handlers = new Map<string, Handler>()

/** The HTTP adapter reuses the exact business handler registered for desktop IPC. */
export function registerRemoteBusinessHandler(channel: string, handler: Handler): void {
  if (remoteChannelPolicies.has(channel)) handlers.set(channel, handler)
}
export function hasRemoteBusinessHandler(channel: string): boolean { return handlers.has(channel) }
export async function invokeRemoteBusinessHandler(channel: string, args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler || !remoteChannelPolicies.has(channel)) throw new Error('This operation requires the Mac.')
  return handler(args)
}
