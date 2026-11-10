import type { ReactNode } from 'react'
import type { Bot } from '../../../shared/types'
import type { ConnectedApp } from '../../../shared/connectedAppTools'
import { BotAppAccess } from './BotAppAccess'

/** Which Bots may use one connected app. Shown on the app detail page. */
export function AppBotAccessList({ service, bots, accessBot, connected, zh }: {
  service: ConnectedApp
  bots?: Bot[]
  accessBot?: Bot
  connected: boolean
  zh: boolean
}): ReactNode {
  if (!bots && !accessBot) return null
  const list = bots ?? (accessBot ? [accessBot] : [])
  return <div className="ob-app-bots">
    <h4>{zh ? '哪些 Bot 可以使用' : 'Bots that may use this app'}</h4>
    {list.length
      ? list.map((bot) => <BotAppAccess key={bot.id} service={service} bot={bot} connected={connected} zh={zh} />)
      : <p className="ob-hint">{zh ? '还没有可用的 Bot。' : 'No Bot is available.'}</p>}
  </div>
}
