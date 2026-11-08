import type { ReactNode } from 'react'
import type { Attachment } from '../../../shared/types'
import { basename } from '../lib/format'
import { pickFiles } from '../state'
import { IconClose } from './Icons'
import { imagePreviewSrc } from './imageAttachments'

/** Asks for files and turns the chosen paths into attachments. */
export async function chooseAttachments(): Promise<Attachment[]> {
  if (window.openbot.dialog.pickAttachments) return window.openbot.dialog.pickAttachments()
  const paths = await pickFiles()
  return paths.map((path, i) => ({
    id: `att-${Date.now()}-${i}`,
    kind: 'file' as const,
    name: window.openbot.environment?.kind === 'browser' ? decodeURIComponent(basename(path)) : basename(path),
    path
  }))
}

interface AttachmentsProps {
  attachments: Attachment[]
  onRemove: (id: string) => void
}

/** What is riding along with the next message. */
export function ComposerAttachments({ attachments, onRemove }: AttachmentsProps): ReactNode {
  if (attachments.length === 0) return null
  return (
    <ul className="ob-composer-attachments">
      {attachments.map((a) => {
        const preview = imagePreviewSrc(a)
        return (
          <li key={a.id} className={preview ? 'is-image' : undefined} title={a.path ?? a.name}>
            {preview ? <img className="ob-composer-attach-thumb" alt="" src={preview} /> : null}
            <span className="ob-composer-attach-name">{a.name}</span>
            <button
              type="button"
              className="ob-icon-btn"
              aria-label={`Remove ${a.name}`}
              onClick={() => onRemove(a.id)}
            >
              <IconClose size={11} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}
