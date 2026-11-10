import { asString } from './validate'
import { CHANNELS } from './channels'
import { emptyArray, handle, handleVoid } from './handler'
import { openSystemPermission, querySystemPermissions } from '../systemPermissions'
import type { SystemPermissionStatus } from '../../shared/systemPermissions'

export function registerSystemPermissionIpc(): void {
  handle<Array<{ id: string; status: SystemPermissionStatus }>>(
    CHANNELS.systemPermissionsStatus,
    ([ids]) => querySystemPermissions(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []),
    emptyArray
  )
  handleVoid(CHANNELS.systemPermissionsOpen, ([id]) => openSystemPermission(asString(id, 80)))
}
