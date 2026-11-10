/** A user-reviewed external message. An uncertain send is never retried automatically. */
export interface GitHubCommentDraft {
  id: string
  sessionId: string
  botId: string
  /** Lead Bot to receive the user's decision and connector receipt. */
  receiverBotId?: string
  owner: string
  repo: string
  issueNumber: number
  body: string
  status: 'draft' | 'sending' | 'sent' | 'uncertain' | 'cancelled'
  createdAt: number
  updatedAt: number
  remoteUrl?: string
  feedbackStatus?: 'pending' | 'delivering' | 'delivered' | 'uncertain'
}

/** A local Gmail draft. A send acknowledgment does not prove delivery. */
export interface GmailDraft {
  id: string
  sessionId: string
  botId: string
  receiverBotId: string
  senderAccount: string
  accountId?: string
  requestScopeId?: string
  requestFingerprint?: string
  sendAuthorization?: { kind: 'saved-rule'; ruleId: string; ruleRevision: number; authorizedAt: number }
  /** Provider confirms that the business POST never started; no automatic retry. */
  sendNotStarted?: boolean
  to: string
  subject: string
  body: string
  status: 'draft' | 'sending' | 'sent' | 'uncertain' | 'cancelled'
  createdAt: number
  updatedAt: number
  remoteId?: string
  feedbackStatus?: 'pending' | 'delivering' | 'delivered' | 'uncertain'
}

export interface SlackDraft {
  id: string
  sessionId: string
  botId: string
  receiverBotId: string
  teamId: string
  slackBotUserId: string
  channelId: string
  threadTs?: string
  text: string
  status: 'draft' | 'sending' | 'sent' | 'uncertain' | 'cancelled'
  createdAt: number
  updatedAt: number
  remoteTs?: string
  feedbackStatus?: 'pending' | 'delivering' | 'delivered' | 'uncertain'
}

/** Calendar event awaiting explicit user confirmation. Times include their offset. */
export interface CalendarDraft {
  id: string
  sessionId: string
  botId: string
  receiverBotId: string
  account: string
  summary: string
  start: string
  end: string
  description: string
  /** Optional invitees; absent on existing personal-event drafts. */
  attendees?: string[]
  status: 'draft' | 'sending' | 'sent' | 'uncertain' | 'cancelled'
  createdAt: number
  updatedAt: number
  remoteId?: string
  feedbackStatus?: 'pending' | 'delivering' | 'delivered' | 'uncertain'
}

export interface XDraft {
  id: string
  sessionId: string
  botId: string
  receiverBotId: string
  userId: string
  username: string
  text: string
  replyToPostId?: string
  status: 'draft' | 'sending' | 'sent' | 'uncertain' | 'cancelled'
  createdAt: number
  updatedAt: number
  remoteId?: string
  feedbackStatus?: 'pending' | 'delivering' | 'delivered' | 'uncertain'
}
