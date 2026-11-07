import { createHash } from 'node:crypto'
import { googleApiGet } from './googleOAuth'
import { googleAccountId, readGoogleCredentials } from './googleSecrets'

/** A bounded snapshot of matching IDs. Polling can miss changes between checks. */
export async function gmailQueryFingerprint(query: string, expectedAccount: string, accountId?: string): Promise<string> {
  if (query.length > 512 || !expectedAccount) throw new Error('Invalid Gmail watch.')
  const account = await readGoogleCredentials('gmail', accountId)
  if (!account || account.account.toLowerCase() !== expectedAccount.toLowerCase()) throw new Error('The Gmail account for this watch is not connected.')
  const page = await googleApiGet('gmail', '/gmail/v1/users/me/messages', { q: query, maxResults: '100' }, undefined, googleAccountId(account.account))
  const after = await readGoogleCredentials('gmail', accountId)
  if (!after || after.account.toLowerCase() !== expectedAccount.toLowerCase()) throw new Error('The Gmail account changed during the check.')
  if (page.messages !== undefined && !Array.isArray(page.messages)) throw new Error('Gmail returned an invalid message list.')
  const messages = (page.messages ?? []) as unknown[]
  if (messages.length > 100) throw new Error('Gmail returned an invalid message list.')
  const ids = messages.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as Record<string, unknown>).id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test((raw as Record<string, unknown>).id as string)) throw new Error('Gmail returned an invalid message id.')
    return (raw as Record<string, string>).id
  }).sort()
  return createHash('sha256').update(JSON.stringify(ids)).digest('hex')
}
