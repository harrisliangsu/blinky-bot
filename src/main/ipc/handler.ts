/**
 * The one wrapper every IPC handler goes through.
 *
 * Guarantees: the sender is one of our own windows, the handler never throws
 * across the bridge, and a failure produces a typed fallback the renderer can
 * render instead of an unhandled rejection.
 */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { publishDesktopEvent } from './eventBus'
import { remoteChannelPolicies } from '../../shared/remoteCapabilities'
import { registerRemoteBusinessHandler } from '../collaboration/businessRegistry'
import { registerNativeHandler } from '../native/stdioBridge'

export type Handler<T> = (args: unknown[]) => T | Promise<T>
export type EventHandler<T> = (event: IpcMainInvokeEvent, args: unknown[]) => T | Promise<T>
export type Fallback<T> = (args: unknown[], error: unknown) => T

/**
 * Only the top-level document of one of our own windows may invoke a channel.
 *
 * `BrowserWindow.fromWebContents` on its own does not establish that: every
 * frame in a page shares the host's WebContents, so a subframe passes it just
 * as the main frame does. `frame-src 'none'` in the renderer CSP means no
 * subframe can exist today, but the sender check is not the place to depend on
 * that — comparing the sending frame against the main frame is what actually
 * makes the guarantee true.
 */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  if (BrowserWindow.fromWebContents(event.sender) === null) return false
  try {
    const frame = event.senderFrame
    // Null once the frame has gone away — nothing left to trust either way.
    if (!frame) return false
    return frame.frameTreeNodeId === event.sender.mainFrame.frameTreeNodeId
  } catch {
    // Reading a destroyed frame throws; refuse rather than guess.
    return false
  }
}

export function handleEvent<T>(channel: string, run: EventHandler<T>, fallback: Fallback<T>): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<T> => {
    if (!isTrustedSender(event)) {
      console.warn('[openbot/ipc] rejected message from untrusted sender', channel)
      return fallback(args, new Error('untrusted sender'))
    }
    try {
      return await run(event, args)
    } catch (error) {
      console.error(`[openbot/ipc] ${channel} failed`, error)
      return fallback(args, error)
    }
  })
}

export function handle<T>(channel: string, run: Handler<T>, fallback: Fallback<T>): void {
  const business: Handler<T> = async args => {
    const result = await run(args)
    if (remoteChannelPolicies.get(channel) === 'write') publishDesktopEvent({ type: 'workspace-updated', area: channel.split(':')[1] ?? '' })
    return result
  }
  registerRemoteBusinessHandler(channel, async args => { try { return await business(args) } catch (error) { return fallback(args, error) } })
  registerNativeHandler(channel, business)
  handleEvent(channel, (_event, args) => business(args), fallback)
}

/** Handlers whose contract is `Promise<void>`. */
export function handleVoid(channel: string, run: (args: unknown[]) => void | Promise<void>): void {
  handle<void>(channel, run, () => undefined)
}

export const emptyArray = (): never[] => []
export const nullResult = (): null => null
