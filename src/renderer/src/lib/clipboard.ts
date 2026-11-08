/** LAN HTTP has no Async Clipboard API. Keep a gesture-based, selectable fallback. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const field = document.createElement('textarea')
  field.value = text; field.readOnly = true
  field.setAttribute('aria-label', '复制内容 / Copy text')
  field.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;font-size:16px'
  document.body.append(field)
  try {
    field.focus({ preventScroll: true }); field.select(); field.setSelectionRange(0, text.length)
    if (!document.execCommand('copy')) throw new Error('剪贴板不可用，请长按消息选择并复制。 / Select the message text and copy it manually.')
  } finally { field.remove(); active?.focus({ preventScroll: true }) }
}
