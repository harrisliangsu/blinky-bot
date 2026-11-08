/** LAN collaboration rooms backed by one OpenBOT conversation. */
export interface CollaborationRoom {
  id: string
  name: string
  sessionId: string
  /**
   * Where guests reach this room, or `''` when nothing is being served.
   *
   * Listing never starts a listener. A verified encrypted recovery record may
   * restore an explicitly shared room at startup, on its saved address/port.
   */
  inviteUrl: string
  /** True while the user is sharing this room. The server answers for no other. */
  enabled: boolean
  recovery?: 'saved' | 'unavailable' | 'address-changed' | 'port-unavailable'
  /** View-only or scoped conversation controls; never remote approval/IPC. */
  permission: 'view' | 'control'
  createdAt: number
  /**
   * When sharing last started. Limits live question controls; an active invite
   * also authorizes paged, public history from this room's designated session.
   */
  sharedFrom: number
}
