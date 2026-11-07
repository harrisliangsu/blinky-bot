import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { RemoteDevice } from '../../../shared/remoteAuth'
import { useAppState } from '../state'
import './RoomDevices.css'

type Device = RemoteDevice & { controlsAvailable: boolean }
/** The same host consent controls appear beside the chat and in room management. */
export function RoomDevices({ roomId, pendingOnly = false }: { roomId?: string; pendingOnly?: boolean }): ReactNode {
  const { currentSessionId, settings } = useAppState()
  const zh = settings?.language !== 'en'
  const remote = window.openbot.environment?.kind === 'browser'
  const [devices, setDevices] = useState<Device[]>([]), [busy, setBusy] = useState(''), [error, setError] = useState('')
  const load = useCallback(async () => {
    const rooms = (await window.openbot.rooms.list()).filter(room => roomId ? room.id === roomId : room.sessionId === currentSessionId)
    const lists = await Promise.all(rooms.map(async room => (await window.openbot.rooms.devices(room.id)).map(device => ({ ...device, controlsAvailable: room.permission === 'control' }))))
    setDevices(lists.flat().filter(device => !pendingOnly || device.state === 'pending'))
  }, [roomId, currentSessionId, pendingOnly])
  useEffect(() => {
    if (remote) return
    let live = true
    const refresh = (): void => { if (live) void load().catch(() => { if (live) setError(zh ? '连接申请未能加载。' : 'Connection requests could not load.') }) }
    refresh()
    const off = window.openbot.on(event => { if (event.type === 'room-devices-changed' && (!roomId || event.roomId === roomId)) refresh() })
    const timer = setInterval(refresh, 5000)
    return () => { live = false; off(); clearInterval(timer) }
  }, [load, roomId, zh, remote])
  const decide = async (device: Device, action: 'approve' | 'deny' | 'revoke' | 'remove', permission: 'view' | 'control' = 'view'): Promise<void> => {
    if (busy) return
    setBusy(device.id); setError('')
    try {
      if (!await window.openbot.rooms.decideDevice(device.roomId, device.id, action, permission, device.scope)) {
        setError(zh ? '操作未被确认。请在当前 Mac 窗口操作，并检查申请是否已过期。' : 'The decision was not confirmed. Use the current Mac window and check whether the request expired.'); return
      }
      await load()
    } catch { setError(zh ? '连接权限未能更新，请重试。' : 'Connection access could not be updated. Try again.') }
    finally { setBusy('') }
  }
  if (remote || pendingOnly && !devices.length && !error) return null
  return <section className="ob-room-devices" aria-label={zh ? '远程设备授权' : 'Remote device access'}>
    <p className="ob-hint">{zh ? '确认这是正在扫码的设备后允许连接。设备名称由客户端填写，可展开核对设备指纹。' : 'Allow only the device you are connecting. Names are supplied by clients; expand the fingerprint to compare devices.'}</p>
    {error ? <p role="alert" className="ob-notice ob-notice-error">{error}</p> : null}
    {!devices.length ? <p className="ob-hint">{zh ? '没有连接申请或已授权设备。' : 'No connection requests or approved devices.'}</p> : null}
    {devices.map(device => <article key={device.id} className="ob-room-device" data-device-id={device.id} data-device-state={device.state}>
      <div><strong>{device.name}</strong> <span>{({ pending: zh ? '等待主机同意' : 'Awaiting host', approved: zh ? '已允许' : 'Approved', denied: zh ? '已拒绝' : 'Denied', revoked: zh ? '已撤销' : 'Revoked', expired: zh ? '已过期' : 'Expired' })[device.state]}</span></div>
      <p className="ob-hint">{device.scope === 'workspace' ? (zh ? '访问范围：整个工作区的 Bot、用户可见聊天、附件、记忆、技能、任务、项目、看板、例程及常规设置。工具与系统授权、凭据及设备批准仍在 Mac 完成。' : 'Scope: workspace Bots, user-visible chats, attachments, memory, skills, tasks, projects, boards, routines and ordinary settings. Tool/system approvals, credentials and device approval remain on the Mac.') : (zh ? '访问范围：此房间的聊天。' : 'Scope: this room’s conversation.')}</p>
      <details><summary>{zh ? '设备编号' : 'Device code'} {device.fingerprint.slice(0, 8)}</summary><code aria-label={zh ? '设备指纹' : 'Device fingerprint'}>{device.fingerprint.match(/.{1,8}/g)?.join(' ')}</code></details>
      <div className="ob-room-device-actions">
        {['pending', 'denied', 'revoked'].includes(device.state) ? <>
          <button type="button" className="ob-btn ob-btn-sm" data-device-view disabled={!!busy} onClick={() => void decide(device, 'approve', 'view')}>{zh ? '允许查看' : 'Allow viewing'}</button>
          {device.controlsAvailable ? <button type="button" className="ob-btn ob-btn-primary ob-btn-sm" data-device-control disabled={!!busy} onClick={() => void decide(device, 'approve', 'control')}>{zh ? '允许操作' : 'Allow controls'}</button> : null}
        </> : null}
        {device.state === 'pending' ? <button type="button" className="ob-btn ob-btn-sm" data-device-deny disabled={!!busy} onClick={() => void decide(device, 'deny')}>{zh ? '拒绝' : 'Deny'}</button> : null}
        {device.state === 'approved' ? <button type="button" className="ob-btn ob-btn-sm" data-device-revoke disabled={!!busy} onClick={() => void decide(device, 'revoke')}>{zh ? '撤销' : 'Revoke'}</button> : null}
        {!['pending', 'approved'].includes(device.state) ? <button type="button" className="ob-btn ob-btn-sm" disabled={!!busy} onClick={() => void decide(device, 'remove')}>{zh ? '移除记录' : 'Remove record'}</button> : null}
      </div>
    </article>)}
  </section>
}
