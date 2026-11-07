import type { AgentEvent } from '../../../shared/events'

export type ReplyActivity = 'reply' | 'reconnect' | 'search' | 'write' | 'command' | 'tool'
export interface ReplyProgressState {
  ended: boolean
  reconnecting: boolean
  // Only ids and coarse operation types: never tool args, stdout or reasoning.
  operations: ReadonlyMap<string, ReplyActivity>
}

export function newReplyProgress(): ReplyProgressState {
  return { ended: false, reconnecting: false, operations: new Map() }
}

function traceActivity(kind: string): ReplyActivity {
  switch (kind) {
    case 'webSearch': return 'search'
    case 'fileChange': return 'write'
    case 'commandExecution': return 'command'
    default: return 'tool'
  }
}

/** Reduce only this chat's observed events. Message boundaries are not run boundaries. */
export function reduceReplyProgress(state: ReplyProgressState, event: AgentEvent, sessionId: string): ReplyProgressState {
  if (!('sessionId' in event) || event.sessionId !== sessionId) return state
  if (event.type === 'run-started') return newReplyProgress()
  if (event.type === 'done' || event.type === 'error') return { ...newReplyProgress(), ended: true }
  if (state.ended) return state
  if (event.type === 'tool-call' || event.type === 'tool-result' || event.type === 'agent-trace') {
    const operations = new Map(state.operations)
    if (event.type === 'tool-call') {
      // A tool-call is a REQUEST, possibly awaiting approval; do not claim
      // that its requested operation has actually started.
      operations.set(`call:${event.call.id}`, 'tool')
    } else if (event.type === 'tool-result') operations.delete(`call:${event.result.callId}`)
    else if (event.entry.phase === 'started') operations.set(`trace:${event.entry.id}`, traceActivity(event.entry.kind))
    else operations.delete(`trace:${event.entry.id}`)
    return { ...state, operations, reconnecting: false }
  }
  if (event.type === 'backend-notice' && event.category === 'reconnect') return { ...state, reconnecting: true }
  // A real delta is evidence the transport is responding again. Its text is
  // never inspected or copied into the status, including private reasoning.
  if ((event.type === 'text-delta' || event.type === 'reasoning-delta') && state.reconnecting) return { ...state, reconnecting: false }
  return state
}

export function replyProgressLabel(state: ReplyProgressState, waitingForApproval: boolean, zh: boolean): string {
  if (state.ended) return ''
  if (waitingForApproval) return zh ? '等待确认' : 'Waiting for approval'
  const activity = state.reconnecting ? 'reconnect' : [...state.operations.values()].at(-1) ?? 'reply'
  const labels: Record<ReplyActivity, [string, string]> = {
    reply: ['正在回复', 'Responding'],
    reconnect: ['正在重新连接', 'Reconnecting'],
    search: ['正在检索', 'Searching'],
    write: ['正在修改文件', 'Updating files'],
    command: ['正在执行命令', 'Running a command'],
    tool: ['正在处理工具请求', 'Handling a tool request']
  }
  return labels[activity][zh ? 0 : 1]
}
