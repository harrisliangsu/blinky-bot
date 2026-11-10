/** Same-executor tool receipts for the owning Bot, without code/file bodies. */
import { isAbsolute } from 'node:path'
import type { Message } from '../../shared/types'
import { redactSecrets } from '../backends/secretRedaction'
export interface ExecutionObservation {
  messageId: string; callId: string; tool: string
  state: 'started' | 'completed' | 'failed' | 'cancelled' | 'unconfirmed'
  origin: 'execution-trace' | 'application-result'
  target?: string; targetSource?: 'raw-input' | 'structured-tool-content'
  outputPresent?: boolean; outputCharacters?: number
}
const nativeKinds = new Set(['read','edit','delete','move','execute','search','fetch','think','mcp','other'])
const readKeys = new Set(['path','file_path','filePath','offset','limit','start_line','end_line','pages','line_numbers'])
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : {}
function target(v: unknown, sanitize: (text:string)=>string): string | undefined {
  const row=object(v)
  for (const key of ['path','file_path','filePath']) {
    const path=row[key]
    if (typeof path==='string' && (isAbsolute(path) || /^[A-Z]:[\\/]/i.test(path))) return sanitize(path).replace(/[\r\n\t]/g,' ').slice(0,512)
  }
  return undefined
}
/** Tool-reported execution is evidence, never automatic user-goal acceptance. */
export function executionObservations(messages: Message[], sanitize: (text:string)=>string = redactSecrets): ExecutionObservation[] {
  const groups=new Map<string,ExecutionObservation>()
  const recent=messages.slice(-24)
  let budget=256_000
  for (const message of recent) {
    if (message.internal || message.uiOnly) continue
    for (const entry of message.agentTrace??[]) {
      if (!entry || (typeof entry.id!=='string'||!entry.id) || !['started','completed'].includes(entry.phase) || typeof entry.detail!=='string') continue
      const key=`${message.id}:${entry.id}`,previous=groups.get(key)
      const row:ExecutionObservation=previous??{messageId:message.id,callId:entry.id,tool:'native-tool',state:'started',origin:'execution-trace'}
      if (nativeKinds.has(entry.kind)) row.tool=entry.kind
      if (entry.phase==='completed') row.state='unconfirmed'
      // A late started/checkpoint event must not demote a completed receipt.
      if ((!row.target || entry.phase==='completed') && entry.detail.length<=16_000 && budget>=entry.detail.length) {
        budget-=entry.detail.length
        try {
          const data=object(JSON.parse(entry.detail)),contents=Array.isArray(data.content)?data.content:[]
          const direct=target(data.rawInput,sanitize) ?? (entry.phase==='started'?target(data,sanitize):undefined)
          if (!row.target && direct) { row.target=direct;row.targetSource='raw-input' }
          for (const content of contents) {
            const text=object(object(content).content).text
            if (typeof text!=='string') continue
            // ACP can stream arguments in content. Completed file output is
            // never parsed as a new target, nor are arbitrary JSON documents.
            if (!row.target && entry.phase==='started') {
              try {
                const input=object(JSON.parse(text))
                if (Object.keys(input).every(key=>readKeys.has(key))) {
                  const path=target(input,sanitize)
                  if (path) { row.target=path;row.targetSource='structured-tool-content' }
                }
              } catch { /* unfinished streamed arguments */ }
            }
            if (entry.phase==='completed') { row.outputPresent=Boolean(text);row.outputCharacters=text.length }
          }
          if (entry.phase==='completed') {
            if (['completed','failed','cancelled'].includes(String(data.status))) row.state=data.status as 'completed'|'failed'|'cancelled'
            else if (typeof data.ok==='boolean') row.state=data.ok?'completed':'failed'
            if (typeof data.output==='string') { row.outputPresent=Boolean(data.output);row.outputCharacters=data.output.length }
          }
        } catch { /* Legacy/unparseable trace remains unconfirmed metadata. */ }
      }
      groups.set(key,row)
      if (groups.size>64) groups.delete(groups.keys().next().value!)
    }
    const result=message.toolResult
    if (result && typeof result.callId==='string' && typeof result.name==='string' && typeof result.ok==='boolean') {
      const call=recent.flatMap(m=>m.toolCalls??[]).find(c=>c.id===result.callId)
      groups.set(`${message.id}:${result.callId}`,{messageId:message.id,callId:result.callId,tool:sanitize(result.name).slice(0,80),state:result.ok?'completed':'failed',origin:'application-result',target:target(call?.args,sanitize),targetSource:'raw-input',outputPresent:Boolean(result.output),outputCharacters:typeof result.output==='string'?result.output.length:0})
    }
    if (groups.size>64) groups.delete(groups.keys().next().value!)
  }
  return [...groups.values()].slice(-16)
}
