/** IPC for `OpenBotApi.backends`. Detection lives in the backend registry. */

import { startCliLogin } from '../app/cliLogin'
import type { BackendInfo } from '../../shared/types'
import { detectBackends, listBackends, recheckBackend } from './backendRegistry'
import { CHANNELS } from './channels'
import { emptyArray, handle } from './handler'
import { asId } from './validate'

export function registerBackendIpc(): void {
  handle<BackendInfo[]>(CHANNELS.backendsList, () => listBackends(), emptyArray)
  handle<BackendInfo[]>(CHANNELS.backendsRefresh, () => detectBackends(), emptyArray)
  handle<BackendInfo[]>(
    CHANNELS.backendsRecheck,
    (args) => recheckBackend(asId(args[0])),
    emptyArray
  )
  handle<{ started: boolean }>(
    CHANNELS.backendsLogin,
    (args) => startCliLogin(asId(args[0])),
    () => ({ started: false })
  )
}
