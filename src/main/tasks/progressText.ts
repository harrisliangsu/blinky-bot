/** Uses the Agent view's task.title, never the Bot name or execution model. */
export function briefProgressText(value: string, limit = 64): string {
  const text = value.replace(/```[\s\S]*?```/g, '').replace(/(?:sha-?256\s*[:=]?\s*)?\b[a-f0-9]{40,64}\b/gi, '')
    .replace(/里程碑|milestones?/gi, '进展').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  const chars = [...text]
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : text
}
export function agentProgressName(taskTitle: string | undefined, sessionTitle?: string): string {
  return briefProgressText(taskTitle?.trim() || sessionTitle?.trim() || '未命名执行会话', 40)
}
export function agentProgressReport(name: string, text: string): string {
  return `${name}：${briefProgressText(text, 72) || '进度已更新。'}`
}
