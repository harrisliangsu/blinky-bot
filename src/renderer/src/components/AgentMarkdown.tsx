import { useMemo, type ReactNode } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { agentText } from './agentTaskPresentation'

/** Normal message typography/code rendering, without navigation, remote media
 * or executable cards in a read-only execution record. */
export function AgentMarkdown({ text }: { text: string }): ReactNode {
  const html = useMemo(() => {
    const template = document.createElement('template')
    template.innerHTML = renderMarkdown(agentText(text))
    for (const element of template.content.querySelectorAll('img,video,audio,source,track,input,button')) element.remove()
    for (const link of template.content.querySelectorAll('a')) link.removeAttribute('href')
    return template.innerHTML
  }, [text])
  return <div className="ob-md" dangerouslySetInnerHTML={{ __html: html }} />
}
