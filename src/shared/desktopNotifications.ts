export interface NotificationStatus { supported: boolean; state: 'idle' | 'requested' | 'shown' | 'failed' | 'unconfirmed'; enabled: boolean; replies: boolean }
export interface NotificationTarget { sessionId: string; botId?: string }
