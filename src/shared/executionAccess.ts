/** Explicit grants only. Different native transports keep their own contracts. */
export function supportsFullAccessExecution(backendId: string): boolean {
  return ['codex', 'claude', 'kimi', 'grok'].includes(backendId)
}

export function executionAccessDescription(backendId: string, zh: boolean): string {
  if (backendId === 'kimi') return zh
    ? 'Kimi 使用 ACP 逐次授权执行，保留原生限制和 Bot 澄清；不启用会自动代答问题的 Never Ask。'
    : 'Kimi uses delegated ACP approvals, retaining native restrictions and Bot clarification; Never Ask is not enabled.'
  if (backendId === 'claude' || backendId === 'grok') return zh
    ? '使用 CLI 原生 bypassPermissions；托管禁用仍有效。通过应用 ask_user 提问。'
    : 'Uses native bypassPermissions; managed restrictions remain. Clarify through the application ask_user tool.'
  if (backendId === 'codex') return zh ? '使用原生 danger-full-access / never，并回读生效参数。' : 'Uses native danger-full-access / never with policy readback.'
  return zh ? '此 CLI 暂无已接通且保留澄清的等价模式，保持原执行方式。' : 'No equivalent profile retaining clarification is connected for this CLI; existing execution is retained.'
}
