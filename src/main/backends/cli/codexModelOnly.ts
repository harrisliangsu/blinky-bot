/** Ephemeral Codex inference without model-controlled host capabilities.
 * The CLI retains its own auth/provider. No tokens are copied or substituted.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AsyncQueue } from '../asyncQueue'
import { JsonRpcPeer } from '../jsonRpc'
import { spawnLines, type ProcessHandle } from '../spawnProcess'
import { isPlainObject } from '../lenientJson'
import { textOf } from '../messageContent'
import type { ChatChunk, ChatRequest } from '../types'
import { MODEL_ONLY_CODEX_VERSION, modelOnlyConfig, modelOnlyFeatures, modelOnlyCatalog, tomlValue } from './codexModelOnlyProfile'
import { codexEffort } from '../../../shared/thinking'
import { ModelOnlyUnavailableError } from '../modelOnlyUnavailable'

const LIMIT_MS = 30_000
export function assertModelOnlyRequest(req: ChatRequest): void {
  if (!req.readOnly || !req.disableNativeTools || req.tools?.length || req.mcpServers?.length ||
      req.messages.some(message => typeof message.content !== 'string' && message.content.some(part => part.type !== 'text'))) {
    throw new Error('Model-only Codex accepts text without tools or MCP servers')
  }
}

function providerId(config: Record<string, unknown>): string { return String(config.model_provider ?? 'openai') }
function assertConfiguration(config: Record<string, unknown>): void {
  const features = isPlainObject(config.features) ? config.features : {}
  if (Object.entries(modelOnlyFeatures()).some(([key, value]) => features[key] !== value)) throw new Error('Codex did not confirm all model-only capability overrides')
  const providers = isPlainObject(config.model_providers) ? config.model_providers : {}
  const chosen = providers[providerId(config)]
  const provider = isPlainObject(chosen) ? chosen : {}
  if (provider.auth || provider.aws || provider.gateway_oauth || config.orchestrator) throw new Error('Model-only Codex cannot verify this provider authentication/runtime configuration')
}

function isolatedProvider(config: Record<string, unknown>): Record<string, unknown> {
  const providers = isPlainObject(config.model_providers) ? config.model_providers : {}
  const selected = providers[providerId(config)]
  if (!isPlainObject(selected) || selected.requires_openai_auth !== false || selected.wire_api !== 'responses' ||
      selected.auth || selected.aws || selected.gateway_oauth || selected.credential_file || selected.experimental_bearer_token ||
      (isPlainObject(selected.http_headers) && Object.keys(selected.http_headers).length) ||
      (isPlainObject(selected.query_params) && Object.keys(selected.query_params).length) || typeof selected.base_url !== 'string') {
    throw new ModelOnlyUnavailableError('Tool-free Codex requires the same existing custom Responses provider with environment-based or no authentication; CLI-managed ChatGPT credentials are not copied')
  }
  const url = new URL(selected.base_url)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search) throw new Error('Cannot isolate a provider with inline URL credentials')
  const result: Record<string, unknown> = { name: selected.name, base_url: selected.base_url, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false }
  if (selected.env_key != null) {
    if (typeof selected.env_key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(selected.env_key)) throw new Error('Invalid provider environment reference')
    result.env_key = selected.env_key
  }
  if (selected.env_http_headers != null) {
    if (!isPlainObject(selected.env_http_headers) || Object.values(selected.env_http_headers).some(value => typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))) throw new Error('Invalid provider header environment reference')
    result.env_http_headers = selected.env_http_headers
  }
  return result
}

export async function* runCodexModelOnly(binary: string, req: ChatRequest): AsyncGenerator<ChatChunk> {
  assertModelOnlyRequest(req)
  if (req.signal.aborted) throw new Error('Model-only inference cancelled')
  const root = await mkdtemp(join(tmpdir(), 'blinky-codex-inference-'))
  let process: ProcessHandle | undefined, peer: JsonRpcPeer | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const queue = new AsyncQueue<ChatChunk>()
  let failure: unknown, finished = false, text = ''
  const fail = (error: unknown): void => { failure ??= error; queue.close(); process?.kill(); peer?.close(error) }
  const abort = (): void => fail(new Error('Model-only inference cancelled'))
  req.signal.addEventListener('abort', abort, { once: true })
  async function boot(config: Record<string, unknown>, extraEnv?: NodeJS.ProcessEnv): Promise<{ handle: ProcessHandle; rpc: JsonRpcPeer; config: Record<string, unknown>; codexHome: string }> {
    if (req.signal.aborted || failure) throw new Error('Model-only inference cancelled')
    const handle = await spawnLines(binary, {
      args: ['app-server', '--strict-config', ...Object.entries(config).flatMap(([key, value]) => ['-c', key + '=' + tomlValue(value)])],
      cwd: root, signal: req.signal, timeoutMs: LIMIT_MS, extraEnv
    })
    process = handle
    const rpc = new JsonRpcPeer(line => handle.write(line + '\n'), (method, value) => {
      const p = isPlainObject(value) ? value : {}
      if (method === 'item/agentMessage/delta' && typeof p.delta === 'string') { text += p.delta; queue.push({ type: 'text', delta: p.delta }) }
      if (method === 'item/started' && isPlainObject(p.item) && !['agentMessage', 'reasoning', 'userMessage'].includes(String(p.item.type))) fail(new Error('Unexpected capability in model-only Codex'))
      if (method === 'turn/completed') {
        finished = true
        const turn = isPlainObject(p.turn) ? p.turn : {}
        if (turn.status !== 'completed') fail(new Error('Model-only Codex turn did not complete'))
        else {
          if (!text && Array.isArray(turn.items)) for (const item of turn.items) {
            if (isPlainObject(item) && item.type === 'agentMessage' && typeof item.text === 'string') queue.push({ type: 'text', delta: item.text })
          }
          queue.push({ type: 'done' }); queue.close()
        }
      }
    })
    peer = rpc
    // Unknown server requests receive -32601, never an approval or tool result.
    void (async () => {
      for await (const line of handle.lines) if (line.stream === 'stdout') rpc.handleLine(line.line)
      if (process === handle && !finished && !failure) fail(new Error('Model-only Codex stopped before completion'))
    })().catch(error => { if (process === handle) fail(error) })
    const initialized = await rpc.request<{ codexHome: string }>('initialize', { clientInfo: { name: 'BlinkyBot-inference', version: '1' }, capabilities: { experimentalApi: true } })
    rpc.notify('initialized')
    const effective = await rpc.request<{ config: Record<string, unknown> }>('config/read', {})
    if (!effective?.config || !isPlainObject(effective.config)) throw new Error('Codex did not return its effective configuration')
    assertConfiguration(effective.config)
    return { handle, rpc, config: effective.config, codexHome: initialized.codexHome }
  }
  async function retire(handle: ProcessHandle, rpc: JsonRpcPeer): Promise<void> {
    if (process === handle) process = undefined
    rpc.close(); handle.kill(); await handle.exit
  }
  try {
    process = await spawnLines(binary, { args: ['--version'], cwd: root, signal: req.signal, timeoutMs: 5_000 })
    let version = ''
    for await (const line of process.lines) if (line.stream === 'stdout') version += line.line
    if ((await process.exit).code !== 0 || version.trim() !== MODEL_ONLY_CODEX_VERSION) throw new Error('Tool-free inference requires verified ' + MODEL_ONLY_CODEX_VERSION)
    const instructions = join(root, 'instructions.txt')
    await writeFile(instructions, 'Answer only from text explicitly supplied by the client. No tools or project context are available.\n')
    const config = modelOnlyConfig(instructions)
    timer = setTimeout(() => fail(new Error('Model-only Codex timed out')), LIMIT_MS)
    // Resolve the CLI's existing default before starting any thread. A model
    // catalog is startup-only: a thread config override would silently do nothing.
    const bootstrap = await boot(config)
    let model = req.model && req.model !== 'default' ? req.model : String(bootstrap.config.model ?? '')
    if (!model) {
      const models = await bootstrap.rpc.request<{ data: Array<{ model: string; isDefault: boolean }> }>('model/list', {})
      model = models.data?.find(entry => entry.isDefault)?.model ?? ''
    }
    const provider = providerId(bootstrap.config)
    const providerConfig = isolatedProvider(bootstrap.config)
    await retire(bootstrap.handle, bootstrap.rpc)
    if (!model) throw new Error('Codex did not identify the existing default model')
    const catalog = join(root, 'model-only-catalog.json')
    await writeFile(catalog, JSON.stringify(modelOnlyCatalog(model)))
    const home = join(root, 'home'), codexHome = join(home, '.codex'), temp = join(root, 'tmp')
    await Promise.all([mkdir(codexHome, { recursive: true }), mkdir(temp)])
    // The original CODEX_HOME is never used for an inference thread: its global
    // AGENTS cannot be disabled through the installed public RPC. Env references
    // retain the same auth in the child; no file/keychain credentials are copied.
    const active = await boot({ ...config, model_catalog_json: catalog, model, model_provider: provider, model_providers: { [provider]: providerConfig } }, {
      HOME: home, CODEX_HOME: codexHome, SHELL: '/bin/sh',
      XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'),
      TMPDIR: temp, TMP: temp, TEMP: temp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'
    })
    if (active.codexHome !== codexHome || providerId(active.config) !== provider || active.config.model !== model || active.config.model_catalog_json !== catalog) throw new Error('Codex did not confirm the same model/provider and isolated capability catalog')
    const hooks = isPlainObject(active.config.hooks) ? active.config.hooks : {}
    if (Object.entries(hooks).some(([key, value]) => key !== 'state' && (!Array.isArray(value) || value.length))) throw new Error('Cannot disable inherited Codex hooks')
    const inherited = isPlainObject(active.config.mcp_servers) ? active.config.mcp_servers : {}
    // Empty tables merge. Disable each inherited name using a nested object;
    // dotted override keys misparse names containing dots or quotes.
    const overrides = { mcp_servers: Object.fromEntries(Object.keys(inherited).map(name => [name, { enabled: false }])) }
    const started = await active.rpc.request<{ thread: { id: string }; sandbox?: { type?: string }; approvalPolicy?: unknown }>('thread/start', {
      cwd: root, model, allowProviderModelFallback: false, config: overrides, ephemeral: true,
      baseInstructions: req.messages.filter(message => message.role === 'system').map(message => textOf(message.content)).join('\n') || 'Answer from the supplied text.',
      developerInstructions: '', approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only',
      dynamicTools: [], environments: [], runtimeWorkspaceRoots: [], selectedCapabilityRoots: []
    })
    if (!started.thread?.id || started.approvalPolicy !== 'never' || started.sandbox?.type !== 'readOnly') throw new Error('Codex did not confirm model-only safety settings')
    if (req.signal.aborted) throw new Error('Model-only inference cancelled')
    await active.rpc.request('turn/start', {
      threadId: started.thread.id, model,
      ...(codexEffort(req.thinking) ? { effort: codexEffort(req.thinking) } : {}),
      input: [{ type: 'text', text: JSON.stringify(req.messages.filter(message => message.role !== 'system').map(message => ({ role: message.role, content: textOf(message.content) }))), text_elements: [] }],
      environments: [], runtimeWorkspaceRoots: []
    })
    for await (const chunk of queue) yield chunk
    if (failure) throw failure
  } finally {
    if (timer) clearTimeout(timer)
    req.signal.removeEventListener('abort', abort)
    peer?.close(); process?.kill()
    if (process) await process.exit
    await rm(root, { recursive: true, force: true })
  }
}
