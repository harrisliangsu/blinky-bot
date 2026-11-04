import { useEffect, useState, type ReactNode } from 'react'
import { createRoom, removeRoom, selectSession, store, useAppState } from '../state'
import { relativeTime } from '../lib/format'
import { IconCopy, IconPlus, IconRefresh, IconTrash } from './Icons'
import { Modal } from './Modal'
import './RoomsPanel.css'

export function RoomsPanel(): ReactNode {
  const { rooms, session } = useAppState()
  const [name, setName] = useState('')
  /*
   * Seeded by an effect, not by `useState(session?.title ?? '')`: that
   * initialiser runs once at mount, while the session and its title arrive over
   * IPC afterwards — so the field sat empty for the very chat the panel was
   * opened from. Keyed on the session as well as the title, so switching chats
   * re-seeds rather than offering the previous room's name.
   */
  useEffect(() => { setName(session?.title ?? '') }, [session?.id, session?.title])
  const copy = (value: string): void => {
    void navigator.clipboard.writeText(value).then(() => store.toast('Invite link copied.'), () => store.toast('The clipboard is unavailable.', 'error'))
  }
  /*
   * Sharing never resumes on its own: OpenBOT stops listening on the network
   * when it quits, and no longer starts listening again merely because a room
   * exists — so a room from an earlier run has no invite link until somebody
   * asks for one here.
   */
  const share = (sessionId: string, roomName: string): void => {
    void createRoom(sessionId, roomName).then((room) => { if (room?.inviteUrl) copy(room.inviteUrl) })
  }
  return <Modal title="Shared rooms" subtitle="Invite people on this local network into a BlinkyBot conversation." size="lg" onClose={() => store.setModal(null)}>
    <div className="ob-rooms-create">
      <input className="ob-input" value={name} placeholder="Room name" onChange={(event) => setName(event.target.value)} />
      <button type="button" className="ob-btn ob-btn-primary" disabled={!session} onClick={() => { if (session) share(session.id, name) }}><IconPlus size={11} /> Share current chat</button>
    </div>
    <p className="ob-hint">Invite links are high-entropy capability URLs. Anyone holding one can read that conversation from the moment you shared it, and can send messages the bot acts on — including running its tools — so share only with people you would let use the bot. Your files, tool output and other chats are never shown. Sharing stops when BlinkyBot quits.</p>
    {rooms.length === 0 ? <p className="ob-hint">No conversations are shared.</p> : <ul className="ob-rooms-list">{rooms.map((room) => <li key={room.id}>
      <button type="button" className="ob-rooms-main" onClick={() => { void selectSession(room.sessionId); store.setModal(null) }}><strong>{room.name}</strong><span>{room.inviteUrl || 'Not shared right now.'}</span><small>created {relativeTime(room.createdAt)}</small></button>
      {room.inviteUrl
        ? <button type="button" className="ob-icon-btn" aria-label={`Copy invite for ${room.name}`} onClick={() => copy(room.inviteUrl)}><IconCopy size={11} /></button>
        : <button type="button" className="ob-icon-btn" aria-label={`Share ${room.name} again`} onClick={() => share(room.sessionId, room.name)}><IconRefresh size={11} /></button>}
      <button type="button" className="ob-icon-btn" aria-label={`Stop sharing ${room.name}`} onClick={() => void removeRoom(room.id)}><IconTrash size={11} /></button>
    </li>)}</ul>}
  </Modal>
}
