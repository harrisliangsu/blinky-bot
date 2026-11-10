import { useEffect, useState, type ReactNode } from 'react'
import {
  addPermission,
  permissionById,
  readPermissionList,
  removePermission,
  statusLabel,
  SYSTEM_PERMISSIONS,
  visiblePermissionIds,
  writePermissionList,
  type PermissionListState,
  type SystemPermissionStatus
} from '../../../shared/systemPermissions'

/** macOS privacy rows. Status is supplied by a real probe; missing answers stay unknown. */
export function SystemPermissionList({ zh, statuses, list, onChange, onOpen }: {
  zh: boolean
  statuses: Record<string, SystemPermissionStatus | undefined>
  list: PermissionListState
  onChange: (next: PermissionListState) => void
  onOpen: (id: string) => void
}): ReactNode {
  const [adding, setAdding] = useState(false)
  const visible = visiblePermissionIds(list)
  const extra = SYSTEM_PERMISSIONS.filter((item) => !visible.includes(item.id))
  return <section className="ob-set-card ob-permissions-card" data-system-permissions="">
    <div>
      <h3>{zh ? '系统权限' : 'System permissions'}</h3>
      <p className="ob-hint">{zh ? '这是 macOS 的隐私与安全性授权。打开系统设置后由你授权；从列表移除只隐藏这一行，不会取消系统里的授权。' : 'These are macOS Privacy & Security grants. System Settings is where you change them. Removing a row only hides it here.'}</p>
    </div>
    <ul className="ob-system-permission-list">
      {visible.map((id) => {
        const item = permissionById(id)
        if (!item) return null
        const status = statuses[id] ?? 'unknown'
        return <li key={id} data-system-permission={id} data-settings-url={item.url}>
          <div>
            <strong>{zh ? item.zh : item.en}</strong>
            <span data-permission-status={status}>{statusLabel(status, zh)}</span>
          </div>
          <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" onClick={() => onOpen(id)}>{zh ? '打开系统设置' : 'Open System Settings'}</button>
          <button type="button" className="ob-btn ob-btn-sm" onClick={() => onChange(removePermission(list, id))}>{zh ? '移除' : 'Remove'}</button>
        </li>
      })}
    </ul>
    {extra.length ? <button type="button" className="ob-btn ob-btn-sm" onClick={() => setAdding((value) => !value)}>{zh ? '添加权限' : 'Add permission'}</button> : null}
    {adding ? <ul className="ob-system-permission-add">
      {extra.map((item) => <li key={item.id}><button type="button" className="ob-btn ob-btn-sm" onClick={() => { onChange(addPermission(list, item.id)); setAdding(false) }}>{zh ? item.zh : item.en}</button></li>)}
    </ul> : null}
  </section>
}

export function SystemPermissionsPanel({ zh }: { zh: boolean }): ReactNode {
  const [list, setList] = useState<PermissionListState>(() => readPermissionList(window.localStorage))
  const [statuses, setStatuses] = useState<Record<string, SystemPermissionStatus>>({})
  const ids = visiblePermissionIds(list).join('|')
  useEffect(() => {
    let live = true
    const wanted = ids ? ids.split('|') : []
    void window.openbot.systemPermissions?.status(wanted).then((rows) => {
      if (!live) return
      const next: Record<string, SystemPermissionStatus> = {}
      for (const row of rows) next[row.id] = row.status
      setStatuses(next)
    }).catch(() => { if (live) setStatuses({}) })
    return () => { live = false }
  }, [ids])
  return <SystemPermissionList zh={zh} statuses={statuses} list={list} onOpen={(id) => { void window.openbot.systemPermissions?.open(id) }} onChange={(next) => { setList(next); writePermissionList(window.localStorage, next) }} />
}
