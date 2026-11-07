/** LAN collaboration rooms backed by one OpenBOT conversation. */
export interface CollaborationRoom {
  id: string
  name: string
  sessionId: string
  /**
   * Where guests reach this room, or `''` when nothing is being served.
   *
   * Empty is the ordinary state after a restart: listing rooms must never start
   * the listener, so a room has no origin until the user has deliberately
   * shared it in this run of the app.
   */
  inviteUrl: string
  /** True while the user is sharing this room. The server answers for no other. */
  enabled: boolean
  /** View-only or scoped conversation controls; never remote approval/IPC. */
  permission: 'view' | 'control'
  createdAt: number
  /**
   * When sharing last started. Limits live question controls; an active invite
   * also authorizes paged, public history from this room's designated session.
   */
  sharedFrom: number
}
