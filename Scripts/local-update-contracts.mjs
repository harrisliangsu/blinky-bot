// Sealed installer contracts. These synchronous functions also execute inside
// the identity-checked application against uniquely resolved live store APIs.
export function assertTransportFence(api, cfg) {
  const task = api.task(cfg.transportTaskId)
  if (!task || task.status !== 'running') throw Error('Installation transport is no longer running')
  if (task.sessionId !== cfg.transportTaskSessionId || task.sourceSessionId !== cfg.sourceSessionId || (task.requesterBotId ?? task.botId) !== cfg.originalBotId) throw Error('Installation transport ownership changed')
  const source = api.get(cfg.sourceSessionId), execution = api.get(cfg.transportTaskSessionId), bot = api.bot(cfg.originalBotId)
  if (!source || source.archived || !source.botIds.includes(cfg.originalBotId) || !bot || bot.archived || !execution || !execution.botIds.includes(task.botId)) throw Error('Installation transport source or Bot is no longer available')
  if (!api.running(cfg.transportTaskSessionId)) throw Error('Installation transport executor is no longer running')
  for (const id of new Set([cfg.sourceSessionId, cfg.transportTaskSessionId])) {
    if (api.suspended(id) || api.cancelled(id)) throw Error('Installation transport was stopped or paused')
  }
  return { taskId: task.id, sourceSessionId: task.sourceSessionId, executionSessionId: task.sessionId, originalBotId: cfg.originalBotId, running: true, stopFlagsClear: true }
}

export function appendOriginalBotReceipt(api, cfg) {
  const session = api.get(cfg.sid), bot = api.bot(cfg.originalBotId)
  if (!session || !session.botIds.includes(cfg.originalBotId) || !bot || bot.archived) throw Error('Authorized receipt source or original Bot is absent')
  const existing = session.messages.find(message => message.id === cfg.id)
  if (existing) {
    if (existing.content !== cfg.text || existing.botId !== cfg.originalBotId || existing.role !== 'assistant') throw Error('Existing receipt identity or body conflicts')
    return { saved: true, idempotent: true, receiptId: cfg.id }
  }
  const updated = api.save({ ...session, messages: [...session.messages, { id: cfg.id, role: 'assistant', botId: cfg.originalBotId, content: cfg.text, createdAt: Date.now() }] })
  if (!updated?.messages.some(message => message.id === cfg.id && message.botId === cfg.originalBotId && message.content === cfg.text)) throw Error('Receipt save failed')
  api.broadcast({ type: 'session-updated', session: updated })
  return { saved: true, idempotent: false, receiptId: cfg.id }
}
