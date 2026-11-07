/** A user-saved exemption for one connected sender and one exact recipient. */
export interface GmailSendRule {
  id: string
  service: 'gmail'
  senderAccount: string
  /** Absent means the legacy default connection only. */
  accountId?: string
  to: string
  enabled: boolean
  revision: number
  createdAt: number
  updatedAt: number
}
