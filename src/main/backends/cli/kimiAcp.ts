/** ACP transports. Credentials and MCP headers are sent only over stdin. */
import { AsyncQueue } from '../asyncQueue'
import { spawnLines } from '../spawnProcess'
import { hydratedEnv } from '../loginShellEnv'
import { createGrokPolicyProbe } from './grokPolicyProbe'
import { redactSecrets } from '../vaultRedaction'
import type { ChatChunk, ChatRequest, ProviderImagePart } from '../types'
import type { CliRunContext } from './spec'
import { agentTraceEntry } from './agentTrace'
import { kimiNativeEnvironment } from './kimiEnvironment'

interface Run {
  binaryPath: string
  ctx: CliRunContext
  req: ChatRequest
  prompt: string
  resumeId?: string
  images?: ProviderImagePart[]
  extraEnv?: Record<string, string>
  onSession(id: string): Promise<void>
}
type Obj = Record<string, unknown>
const object = (x: unknown): Obj => x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {}
const str = (x: unknown): string => typeof x === 'string' ? x : ''
const truncate = (text: string, max: number): string => text.length > max ? `${text.slice(0, max)}\n… [truncated]` : text

/** No shell, no global MCP config and no credentials in argv or logs. */
export async function* runKimiAcp(run: Run): AsyncGenerator<ChatChunk> { yield* runAcp(run, 'kimi') }
export async function* runGrokAcp(run: Run): AsyncGenerator<ChatChunk> { yield* runAcp(run, 'grok') }

async function* runAcp(run: Run, provider: 'kimi' | 'grok'): AsyncGenerator<ChatChunk> {
  const { req, ctx } = run
  const label = provider === 'kimi' ? 'Kimi' : 'Grok'
  if (provider === 'grok' && ctx.extraArgs.some((arg) => /^(--always-approve|--permission-mode|--allow|--allowed-tools|--allowedTools)(=|$)/.test(arg))) throw new Error('Grok extra arguments cannot override the application permission policy.')
  if (provider === 'kimi' && ctx.extraArgs.some((arg) => /^(--auto|--yolo|-y)(=|$)/.test(arg))) throw new Error('Kimi extra arguments cannot override the application permission policy.')
  const servers: Obj[] = (req.mcpServers ?? []).flatMap((s): Obj[] => {
    if (s.transport === 'http' && s.url) return [{ name: s.name, type: 'http', url: s.url, headers: s.bearerToken ? [{ name: 'Authorization', value: `Bearer ${s.bearerToken}` }] : [] }]
    if (s.transport === 'stdio' && s.command) return [{ name: s.name, command: s.command, args: s.args ?? [], env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })) }]
    throw new Error(`${label} ACP cannot use the MCP server ${s.name}: its transport is incomplete`)
  })
  const probe = provider === 'grok' ? await createGrokPolicyProbe() : undefined
  const args = provider === 'kimi'
    ? [...(ctx.model && ctx.model !== 'default' ? ['--model', ctx.model] : []), ...ctx.extraArgs, 'acp']
    : ['--no-auto-update', '--permission-mode', 'default', ...(ctx.model && ctx.model !== 'default' ? ['--model', ctx.model] : []), ...ctx.extraArgs, 'agent', '--plugin-dir', probe!.pluginDir, 'stdio']
  let nativeEnv: NodeJS.ProcessEnv | undefined
  let process: Awaited<ReturnType<typeof spawnLines>>
  try {
    const baseEnv = await hydratedEnv()
    nativeEnv = provider === 'kimi' ? kimiNativeEnvironment(baseEnv) : baseEnv
    process = await spawnLines(run.binaryPath, { args, cwd: ctx.cwd, stdin: 'pipe', signal: req.signal, timeoutMs: 30 * 60_000, extraEnv: { ...run.extraEnv, ...(probe ? { BLINKY_GROK_POLICY_MARKER: probe.markerPath } : {}) }, ...(nativeEnv ? { env: nativeEnv } : {}) })
  } catch (error) { await probe?.cleanup(); throw error }
  const output = new AsyncQueue<ChatChunk>()
  const pending = new Map<number, { resolve(value: Obj): void; reject(error: Error): void }>()
  const toolCalls = new Map<string, Obj>()
  let nextId = 0
  let active = false
  let finished = false
  const write = (value: unknown): void => process.write(`${JSON.stringify(value)}\n`)
  const rpc = (method: string, params: Obj): Promise<Obj> => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    try { write({ jsonrpc: '2.0', id, method, params }) } catch (error) {
      pending.delete(id); reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
  const rejectPending = (error: Error): void => { for (const call of pending.values()) call.reject(error); pending.clear() }
  const stopUnapproved = (description: string): void => {
    if (finished || req.signal.aborted) return
    const error = new Error(`${label} 的操作未获批准：${redactSecrets(description).slice(0, 400)}。本轮已停止，请先检查已发生的操作。`)
    finished = true
    output.close(error)
    rejectPending(error)
    process.kill()
  }
  const handlePermission = async (id: number | string, params: Obj): Promise<void> => {
    const call = object(params.toolCall)
    const prior = toolCalls.get(str(call.toolCallId)) ?? {}
    const contents = [...(Array.isArray(call.content) ? call.content : []), ...(Array.isArray(prior.content) ? prior.content : [])].map(object)
    const diff = contents.find((item) => item.type === 'diff')
    const kind = str(call.kind) || str(prior.kind) || (diff ? 'edit' : '')
    // Kimi can omit `kind` entirely for real permission requests. Unknown
    // kinds must still reach the user as a generic forced approval; silently
    // cancelling them makes legitimate actions impossible to authorize.
    const classification = kind === 'execute' ? 'shell' : kind === 'edit' ? 'edit' : kind === 'delete' || kind === 'move' ? 'delete' : kind === 'fetch' || kind === 'read' || kind === 'search' ? 'fetch' : 'mcp'
    let selected: Obj | undefined
    let rejected = !req.approve
    let description = str(call.title) || `${label} requested permission`
    if (req.approve && !req.signal.aborted) {
      let raw = Object.keys(object(call.rawInput)).length ? object(call.rawInput) : object(prior.rawInput)
      if (!Object.keys(raw).length) {
        for (const item of contents) {
          const text = str(object(item.content).text)
          if (!text || text.length > 32_000) continue
          try { const parsed = object(JSON.parse(text)); if (Object.keys(parsed).length) { raw = parsed; break } } catch { /* ordinary explanatory text */ }
        }
      }
      const title = str(call.title) || str(call.toolCallId) || `${label} requested permission`
      const target = ['command', 'cmd', 'path', 'file_path', 'filePath', 'url'].map((key) => str(raw[key])).find((value) => value.trim()) || str(diff?.path) || title
      description = target === title ? title : `${title}: ${target}`
      const summary = redactSecrets(title).slice(0, 400)
      const change = diff && (typeof diff.oldText === 'string' || typeof diff.newText === 'string')
        ? `\nBefore:\n${truncate(str(diff.oldText), 700)}\nAfter:\n${truncate(str(diff.newText), 700)}` : ''
      // Internal task requests need an intelligible target without displaying
      // arbitrary report bodies or credentials in a generic MCP approval card.
      const taskInput = Object.keys(object(raw.arguments)).length ? object(raw.arguments) : raw
      const action = str(taskInput.action), taskId = str(taskInput.task_id)
      const taskTarget = /^[a-z_]{1,32}$/.test(action) ? `\nAction: ${action}${/^[a-f0-9-]{36}$/i.test(taskId) ? `\nTask: ${taskId}` : ''}` : ''
      const detail = truncate(redactSecrets(`${target === title ? title : `${title}\n${target}`}${taskTarget}${change}`), 2000)
      // An ACP permission request is an explicit request from the native
      // executor, not an ordinary application tool call. Preserve the request
      // for the user even when ordinary application tools run automatically.
      const decision = await req.approve({ kind: classification, summary, detail, target, force: true })
      const options = Array.isArray(params.options) ? params.options.map(object) : []
      if (decision !== 'reject') selected = options.find((o) => o.kind === 'allow_once')
      else { rejected = true; selected = options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always') }
      if (!selected) rejected = true
    }
    write({ jsonrpc: '2.0', id, result: { outcome: selected && str(selected.optionId) ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' } } })
    // A native executor may retry the same rejected action through another
    // tool. Stop this turn instead of allowing repeated approval prompts.
    if (rejected) stopUnapproved(description)
  }
  const pump = (async () => {
    try {
      for await (const { stream, line } of process.lines) {
        if (stream !== 'stdout') continue
        let message: Obj
        try { message = object(JSON.parse(line)) } catch { continue }
        const id = message.id
        if (message.method === 'session/update') {
          if (!active) continue // session/load replays prior history
          const update = object(object(message.params).update)
          if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && str(update.toolCallId)) {
            const key = str(update.toolCallId)
            const prior = toolCalls.get(key) ?? {}
            const rawInput = object(update.rawInput)
            const fields = ['command', 'cmd', 'path', 'file_path', 'filePath', 'url']
            const safeInput = Object.fromEntries(fields.flatMap((field) => typeof rawInput[field] === 'string' ? [[field, str(rawInput[field]).slice(0, 4096)]] : []))
            const safeContent = Array.isArray(update.content) ? update.content.slice(0, 4).flatMap((item): Obj[] => {
              const entry = object(item), text = str(object(entry.content).text)
              if (entry.type === 'content' && text.length <= 4096) return [{ type: 'content', content: { text } }]
              if (entry.type === 'diff') return [{ type: 'diff', path: str(entry.path).slice(0, 4096), oldText: truncate(str(entry.oldText), 700), newText: truncate(str(entry.newText), 700) }]
              return [] // Never retain screenshots or other binary tool content here.
            }) : undefined
            toolCalls.set(key, { ...prior, ...(str(update.kind) ? { kind: str(update.kind) } : {}), ...(Object.keys(safeInput).length ? { rawInput: safeInput } : {}), ...(safeContent?.length ? { content: safeContent } : {}) })
            if (toolCalls.size > 256) toolCalls.delete(toolCalls.keys().next().value!)
          }
          if (update.sessionUpdate === 'tool_call') output.push({ type: 'reasoning', delta: 'tool activity', toolActivity: true })
          if (req.captureAgentTrace && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')) {
            const phase = update.status === 'completed' || update.status === 'failed' ? 'completed' : 'started'
            output.push({ type: 'agent_trace', entry: agentTraceEntry(str(update.toolCallId), str(update.kind) || `${provider}_tool`, phase, update) })
          }
          const content = object(update.content)
          if (content.type === 'text' && typeof content.text === 'string') {
            if (update.sessionUpdate === 'agent_message_chunk') output.push({ type: 'text', delta: content.text, visible: true })
            else if (update.sessionUpdate === 'agent_thought_chunk') output.push({ type: 'reasoning', delta: content.text })
          }
        } else if (message.method === 'session/request_permission' && (typeof id === 'number' || typeof id === 'string')) {
          void handlePermission(id, object(message.params)).catch(() => {
            try { write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } }) } catch { /* closed */ }
            stopUnapproved(`${label} requested permission`)
          })
        } else if (message.method && (typeof id === 'number' || typeof id === 'string')) {
          write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported client method' } })
        } else if (typeof id === 'number') {
          const callback = pending.get(id)
          if (callback) {
            pending.delete(id)
            if (message.error) callback.reject(new Error(`${label} ACP request failed (${str(object(message.error).message) || String(object(message.error).code)})`))
            else callback.resolve(object(message.result))
          }
        }
      }
      if (!finished) rejectPending(new Error(req.signal.aborted ? `${label} request cancelled` : `${label} ACP exited before completing the request`))
    } catch (error) {
      rejectPending(error instanceof Error ? error : new Error(String(error)))
    }
  })()
  const execute = (async () => {
    try {
      const init = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'BlinkyBot', version: '0.3.9' } })
      if (provider === 'grok') {
        const methods = Array.isArray(init.authMethods) ? init.authMethods.map(object).map((entry) => str(entry.id)) : []
        const hasKey = Boolean(run.extraEnv?.XAI_API_KEY || nativeEnv?.XAI_API_KEY)
        const methodId = hasKey && methods.includes('xai.api_key') ? 'xai.api_key' : methods.includes('cached_token') ? 'cached_token' : ''
        if (!methodId) throw new Error('Grok ACP has no available non-interactive authentication method.')
        await rpc('authenticate', { methodId, _meta: { headless: true } })
      }
      if (!object(object(init.agentCapabilities).mcpCapabilities).http && servers.some((s) => s.type === 'http')) throw new Error(`${label} ACP does not support HTTP MCP servers`)
      if ((run.images?.length ?? 0) > 0 && !object(object(init.agentCapabilities).promptCapabilities).image) throw new Error(`This ${label} ACP version does not support image input`)
      let sessionId = run.resumeId
      if (sessionId) {
        // Do not silently replace a session on a transient load error: the
        // caller's prompt can contain only the new messages, and creating a
        // fresh session here would lose the earlier conversation.
        await rpc('session/load', { sessionId, cwd: ctx.cwd, mcpServers: servers })
      }
      if (!sessionId) {
        const created = await rpc('session/new', { cwd: ctx.cwd, mcpServers: servers })
        sessionId = str(created.sessionId)
        if (!sessionId) throw new Error(`${label} ACP did not return a session id`)
      }
      // Both CLIs accept model flags but their ACP sessions can ignore them.
      // Set and read back the actual session options before sending a prompt.
      const setOption = async (configId: string, value: string): Promise<void> => {
        const result = await rpc('session/set_config_option', { sessionId, configId, value })
        const options = Array.isArray(result.configOptions) ? result.configOptions.map(object) : []
        if (str(options.find((option) => option.id === configId)?.currentValue) !== value) throw new Error(`${label} did not confirm the requested ${configId}.`)
      }
      if (provider === 'grok') await probe!.verify(sessionId)
      else await setOption('mode', 'default')
      if (ctx.model && ctx.model !== 'default') await setOption('model', ctx.model)
      if (req.thinking) {
        const allowed = provider === 'grok' ? ['low', 'medium', 'high', 'xhigh'] : ['low', 'high', 'max']
        if (!allowed.includes(req.thinking)) throw new Error(`${label} ACP does not support this reasoning depth.`)
        await setOption(provider === 'grok' ? 'reasoning_effort' : 'thinking', req.thinking)
      }
      await run.onSession(sessionId)
      const prompt: Obj[] = [{ type: 'text', text: run.prompt }]
      for (const image of run.images ?? []) prompt.push({ type: 'image', mimeType: image.mime, data: image.data })
      active = true
      const result = await rpc('session/prompt', { sessionId, prompt })
      if (result.stopReason === 'cancelled' && !req.signal.aborted) throw new Error(`${label} cancelled the turn`)
      if (!req.signal.aborted) output.push({ type: 'done' })
      finished = true
      output.close()
    } catch (error) {
      finished = true
      output.close(req.signal.aborted ? undefined : error)
    } finally { process.kill() }
  })()
  try { for await (const chunk of output) yield chunk }
  finally { process.kill(); rejectPending(new Error(`${label} ACP closed`)); await Promise.allSettled([execute, pump]); await probe?.cleanup() }
}
