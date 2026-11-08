import { copyText } from '../lib/clipboard'
import { RoomDevices } from './RoomDevices'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { CollaborationRoom } from '../../../shared/types'
import { createRoom, loadRooms, removeRoom, selectSession, store, useAppState } from '../state'
import { IconCopy, IconPlus, IconRefresh } from './Icons'
import { FormDialog } from './FormDialog'
import { resolveSettingsLang } from '../lib/settingsCopy'
import './RoomsPanel.css'

type Draft = { sessionId: string; name: string; permission: 'view' | 'control'; editing: boolean }
export function RoomsPanel(): ReactNode {
  const { rooms, session, settings } = useAppState()
  const zh = resolveSettingsLang(settings?.language ?? 'system', navigator.language) === 'zh-CN'
  const scope = useId(), anchor = `#${CSS.escape(scope)} [data-room-add]`
  const [draft, setDraft] = useState<Draft | null>(null)
  const [inviteId, setInviteId] = useState<string | null>(null)
  const [qr, setQr] = useState<{ url: string; data: string } | null>(null)
  const [qrError, setQrError] = useState(false)
  const [busy, setBusy] = useState(false), saving = useRef(false)
  const [stopping, setStopping] = useState<string | null>(null)
  const [error, setError] = useState('')
  const invitation = rooms.find(room => room.id === inviteId)
  useEffect(() => { void loadRooms(); const timer = setInterval(() => { void loadRooms() }, 15000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    let active = true; setQr(null); setQrError(false)
    if (invitation?.inviteUrl) void window.openbot.rooms.qr(invitation.id).then(data => {
      if (active) { if (data) setQr({ url: invitation.inviteUrl, data }); else setQrError(true) }
    }, () => { if (active) setQrError(true) })
    return () => { active = false }
  }, [invitation?.id, invitation?.inviteUrl])
  const edit = (room?: CollaborationRoom): void => {
    if (saving.current || (!room && !session)) return
    setError(''); setDraft({ sessionId: room?.sessionId ?? session!.id, name: room?.name ?? session?.title ?? '', permission: room?.permission ?? 'control', editing: room?.enabled === true })
  }
  const closeDraft = (): void => { if (!saving.current) { setDraft(null); setError('') } }
  const save = async (): Promise<void> => {
    if (!draft || saving.current) return
    saving.current = true; setBusy(true); setError('')
    try {
      const room = await createRoom(draft.sessionId, draft.name, draft.permission)
      if (!room?.inviteUrl) { setError(zh ? '共享未开启。请检查局域网连接后重试。' : 'Sharing did not start. Check the LAN connection and retry.'); return }
      setDraft(null); setInviteId(room.id)
    } finally { saving.current = false; setBusy(false) }
  }
  const connect = async (): Promise<void> => {
    if (!session || saving.current) return
    saving.current = true; setBusy(true); setError('')
    try {
      const existing = rooms.find(room => room.sessionId === session.id && room.inviteUrl)
      const room = existing ?? await createRoom(session.id, session.title, 'control')
      if (!room?.inviteUrl) { setError(zh ? '连接未开启，请检查同一 Wi-Fi 后重试。' : 'Could not start. Check the Wi-Fi connection and retry.'); return }
      setInviteId(room.id)
    } finally { saving.current = false; setBusy(false) }
  }
  const stop = async (id: string): Promise<void> => { if (stopping) return; setStopping(id); try { if (await removeRoom(id)) setInviteId(current => current === id ? null : current) } finally { setStopping(null) } }
  const copy = (url: string): void => { void copyText(url).then(() => store.toast(zh ? '邀请链接已复制。' : 'Invite link copied.'), () => store.toast(zh ? '剪贴板不可用。' : 'Clipboard unavailable.', 'error')) }
  return <FormDialog title={zh ? '远程连接与共享' : 'Remote access and sharing'} subtitle={zh ? '邀请同一 Wi-Fi 的设备申请连接。每台设备须由主机核对身份并明确批准工作区范围和权限。' : 'Invite devices on the same Wi-Fi to request a connection. Verify each device and explicitly approve its workspace scope and permissions on the Mac.'} size="lg" fallbackFocus="#ob-prompt" onClose={() => store.setModal(null)}>
    <div id={scope} className="ob-rooms">
      <div className="ob-rooms-toolbar"><button data-room-add type="button" className="ob-btn ob-btn-primary" disabled={!session || busy} onClick={() => void connect()}><IconPlus size={12} />{busy ? (zh ? '正在开启…' : 'Starting…') : zh ? '显示连接二维码' : 'Show connection QR'}</button></div>
      <p className="ob-hint">{zh ? '同一 Wi-Fi：手机扫码 → 确认设备名称 → 在 Mac 允许连接。链接只用于申请，批准前不能读取任何聊天或操作。主机可允许只读或操作整个工作区，随时拒绝或撤销；系统及工具审批仍在 Mac 完成。退出期间连接暂停；重新打开 App 后在原地址恢复共享，已批准设备可在原八小时期限内自动重连。停止共享或撤销后不会恢复。' : 'On the same Wi-Fi: scan → confirm the device name → allow on this Mac. The link only requests access; no chats or actions are available before approval. Grant workspace viewing or controls, and deny or revoke at any time. System and tool approvals remain on the Mac. Connections pause on quit. Reopening the app restores sharing at the same address within the original eight-hour approval. Stopped sharing and revoked devices stay stopped.'}</p>
      {error && !draft ? <p role="alert">{error}</p> : null}
      {!rooms.length ? <p className="ob-hint">{zh ? '还没有共享房间。' : 'No shared rooms.'}</p> : <ul className="ob-rooms-list">{rooms.map(room => <li key={room.id} data-room-id={room.id}>
        <div className="ob-rooms-main"><strong>{room.name}</strong><span>{room.enabled && room.inviteUrl ? (room.permission === 'view' ? (zh ? '共享中 · 仅查看' : 'Sharing · view only') : (zh ? '共享中 · 允许操作' : 'Sharing · controls enabled')) : (room.enabled ? (zh ? '等待恢复连接' : 'Waiting to restore sharing') : (zh ? '未开启' : 'Off'))}</span></div>
        <div className="ob-rooms-actions">
          {room.inviteUrl ? <><button type="button" className="ob-btn ob-btn-sm" data-room-invite onClick={() => setInviteId(room.id)}>{zh ? '邀请 / 二维码' : 'Invite / QR'}</button><button type="button" className="ob-btn ob-btn-sm" data-room-edit onClick={() => edit(room)}>{zh ? '修改' : 'Edit'}</button></> : <button type="button" className="ob-btn ob-btn-sm" data-room-reshare onClick={() => edit(room)}><IconRefresh size={12}/>{zh ? '重新共享' : 'Share again'}</button>}
          <button type="button" className="ob-btn ob-btn-sm" data-room-stop disabled={stopping !== null} onClick={() => void stop(room.id)}>{stopping === room.id ? (zh ? '正在停止…' : 'Stopping…') : room.inviteUrl ? (zh ? '停止共享' : 'Stop sharing') : (zh ? '移除' : 'Remove')}</button>
          <button type="button" className="ob-btn ob-btn-sm" onClick={() => { void selectSession(room.sessionId); store.setModal(null) }}>{zh ? '打开聊天' : 'Open chat'}</button>
        </div>
        {room.enabled ? <p className="ob-hint" role="status">{room.recovery === 'saved' ? (zh ? '已安全保存重启恢复；设备批准不延长期限。' : 'Secure restart recovery saved; approvals keep their expiry.') : room.recovery === 'address-changed' ? (zh ? '原 Wi-Fi 地址不可用。回到原网络可自动恢复；换网络请在 Mac 重新共享地址。' : 'The saved Wi-Fi address is unavailable. Rejoin that network or share a new address from the Mac.') : room.recovery === 'port-unavailable' ? (zh ? '原连接端口被占用，未改用其他地址。请在 Mac 排查后重试。' : 'The saved port is occupied. Check the conflicting listener on the Mac and retry.') : (zh ? '系统安全存储不可用：当前仅临时共享，重启后需重新开启和批准。' : 'Secure storage unavailable: temporary sharing only; restart requires sharing and approval again.')}</p> : null}<RoomDevices roomId={room.id} />
      </li>)}</ul>}
      {draft ? <FormDialog title={draft.editing ? (zh ? '修改共享' : 'Edit sharing') : (zh ? '共享当前聊天' : 'Share chat')} size="md" fallbackFocus={anchor} onClose={closeDraft}>
        <form className="ob-rooms-form" onSubmit={event => { event.preventDefault(); void save() }}>
          <label className="ob-field"><span className="ob-label">{zh ? '房间名称' : 'Room name'}</span><input className="ob-input" data-room-name maxLength={200} value={draft.name} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })}/></label>
          <label className="ob-check"><input data-room-control type="checkbox" checked={draft.permission === 'control'} disabled={busy} onChange={event => setDraft({ ...draft, permission: event.target.checked ? 'control' : 'view' })}/>{zh ? '允许手机发送消息、停止与回答普通澄清' : 'Allow sending, stopping, and ordinary question answers'}</label>
          <p className="ob-hint">{zh ? '关闭此项将限制已批准设备为只读。每台新设备仍需主机明确批准；链接本身不授予访问。仅在可信局域网使用 HTTP 连接。' : 'Turning this off limits approved devices to viewing. Every new device still requires explicit host approval; the link does not grant access. Use HTTP connections only on a trusted LAN.'}</p>
          {error ? <p role="alert" className="ob-notice ob-notice-error">{error}</p> : null}
          <div className="ob-rooms-form-actions"><button type="button" className="ob-btn" disabled={busy} onClick={closeDraft}>{zh ? '取消' : 'Cancel'}</button><button type="submit" className="ob-btn ob-btn-primary" disabled={busy}>{busy ? (zh ? '正在保存…' : 'Saving…') : draft.editing ? (zh ? '保存' : 'Save') : (zh ? '开启共享' : 'Start sharing')}</button></div>
        </form>
      </FormDialog> : null}
      {inviteId ? <FormDialog title={zh ? '邀请同一 Wi-Fi 的设备' : 'Invite a device on this Wi-Fi'} size="sm" fallbackFocus={anchor} onClose={() => setInviteId(null)}>
        {invitation?.inviteUrl ? <div className="ob-rooms-invite">
          {qr?.url === invitation.inviteUrl ? <img className="ob-rooms-qr" data-room-qr src={qr.data} alt={zh ? '当前共享邀请二维码' : 'QR code for this invitation'}/> : <p role="status">{qrError ? (zh ? '二维码未生成，可复制链接。' : 'QR unavailable; use the link below.') : (zh ? '正在本机生成二维码…' : 'Generating QR on this Mac…')}</p>}
          <p className="ob-hint">{zh ? '手机相机扫码，确认设备名称，然后在 Mac 允许。已批准设备断线后会自动重连。Mac 需保持联网和唤醒。' : 'Scan, confirm the device name, then allow on this Mac. Approved devices reconnect automatically. Keep this Mac awake and connected.'}</p>
          <input className="ob-input" data-room-link readOnly aria-label={zh ? '邀请链接' : 'Invitation link'} value={invitation.inviteUrl}/>
          <button type="button" className="ob-btn" data-room-copy onClick={() => copy(invitation.inviteUrl)}><IconCopy size={12}/>{zh ? '复制邀请链接' : 'Copy invitation link'}</button>
        </div> : <p role="status">{zh ? '共享已停止，请重新开启后生成邀请。' : 'Sharing is off. Start it again for a new invitation.'}</p>}
      </FormDialog> : null}
    </div>
  </FormDialog>
}
