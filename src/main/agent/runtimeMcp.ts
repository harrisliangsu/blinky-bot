/**
 * Which backends can be handed an MCP server for a single turn.
 *
 * Checked against the installed CLIs:
 *   claude  `--mcp-config '<json>'` — inline JSON, http transport with headers
 *   codex   `-c mcp_servers.<name>={url=…,bearer_token_env_var=…}`
 *
 * OpenCode reads MCP from config, but supports OPENCODE_CONFIG_CONTENT. Its
 * adapter starts an ephemeral, per-turn server with that inline config, so the
 * gateway token never touches the user's own opencode.json. Droid still needs a
 * persistent config and pi has no MCP client.
 *
 * A list, not a guess: the gateway's HTTP listener is only started for a
 * backend on it, so an unlisted CLI never leaves a port open for a client that
 * will never connect. The other half of this pairing — how each
 * CLIs is actually told — is `backends/cli/mcpConfig.ts`; the two are kept
 * apart because the agent package treats the backends package as an optional
 * peer and cannot import it statically. Kimi and Grok ACP transports accept
 * HTTP MCP servers for each new or loaded session without changing global config.
 */

const RUNTIME_MCP_BACKENDS: ReadonlySet<string> = new Set(['opencode', 'claude', 'codex', 'kimi', 'grok'])

export function acceptsRuntimeMcpServer(backendId: string): boolean {
  return RUNTIME_MCP_BACKENDS.has(backendId)
}

/** Do not let a supported CLI silently run without the application's tools. */
export function requireRuntimeMcpServer<T>(backendId: string, server: T | null | undefined): T | null {
  if (acceptsRuntimeMcpServer(backendId) && !server) throw new Error('应用工具网关未能启动，本轮未执行。请检查工具连接后重试。')
  return server ?? null
}
