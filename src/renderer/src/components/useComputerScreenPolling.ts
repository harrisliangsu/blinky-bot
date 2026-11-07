import { useEffect } from 'react'
import { captureBotScreen } from '../state'

/**
 * Re-captures the private screen while someone is looking at it. Hands-on
 * control needs a near-live picture; watching the bot work does not.
 */
export function useComputerScreenPolling(botId: string | undefined, sessionId: string | undefined, shouldPoll: boolean, takeover: boolean): void {
  useEffect(() => {
    if (!botId || !shouldPoll) return
    let disposed = false
    let timer: number | undefined

    const capture = async (): Promise<void> => {
      await captureBotScreen(botId, { quiet: true, sessionId })
      if (!disposed) timer = window.setTimeout(() => void capture(), takeover ? 350 : 1500)
    }

    void capture()
    return () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [botId, sessionId, shouldPoll, takeover])
}
