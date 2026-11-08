import type { ReactNode } from 'react'
import type { RichCardSpec } from '../../../shared/types'
import { store } from '../state'
import { copyText } from '../lib/clipboard'
import { IconCopy } from './Icons'
import './RichCard.css'

/*
 * A card's contents are model-authored, and a model repeats what it has read: a
 * fetched page can name the exact card it wants drawn. Message.tsx refuses to
 * markdown-render tool output for that reason — so a page cannot paint fake
 * OpenBOT UI in the transcript — and the card fence hands that same drawing
 * capability back through the assistant channel. Every card therefore says where
 * its contents came from, and RichCard.css keeps the frame shaped like quoted
 * assistant prose rather than like one of the app's own panels.
 */
const ORIGIN_NOTE = 'Written by the bot from this conversation. Nothing is sent or opened until you do it.'

/**
 * How much of a body a mailto: URL may carry.
 *
 * `parseCard` accepts 20,000 characters, which percent-encodes into a URL past
 * 60KB — mail clients truncate one that long rather than refuse it, so the draft
 * looks whole here and arrives cut in half. The Copy button beside the link
 * carries the full text.
 */
const MAILTO_BODY_MAX = 2000

/**
 * A mailto: URL with each field percent-encoded, per RFC 6068.
 *
 * `new URLSearchParams()` writes application/x-www-form-urlencoded, where a
 * space becomes `+`. RFC 6068 gives `+` no meaning inside an hfield, so Apple
 * Mail, Outlook and Thunderbird all render it literally and every draft opened
 * as `Hi+there,+please+review`.
 */
function mailtoUrl(spec: Extract<RichCardSpec, { type: 'email-draft' }>): string {
  const fields = [`subject=${encodeURIComponent(spec.subject)}`, `body=${encodeURIComponent(spec.body.slice(0, MAILTO_BODY_MAX))}`]
  if (spec.cc?.length) fields.push(`cc=${encodeURIComponent(spec.cc.join(','))}`)
  return `mailto:${spec.to.map((address) => encodeURIComponent(address)).join(',')}?${fields.join('&')}`
}

/**
 * The host a link card would really open, or null when the URL will not parse.
 *
 * Parsed rather than read off the string: `https://person1@example.test/reset`
 * reads as google.com to a person but its host is `evil.example`, and `new URL()`
 * additionally punycode-normalises an IDN homograph into something inspectable.
 * Electron has no status bar, so this is the only place the destination of a
 * model-supplied link can be seen before it opens in the real, logged-in browser.
 */
function linkHost(url: string): string | null {
  try { return new URL(url).host } catch { return null }
}

/** Shared frame: kind label, provenance marking, then the card's own actions. */
function CardShell({ kind, title, actions, children }: { kind: string; title: string; actions?: ReactNode; children?: ReactNode }): ReactNode {
  return <article className="ob-rich-card">
    <header><span className="ob-rich-card-kind">{kind}<em>from the bot</em></span><strong>{title}</strong></header>
    {children}
    <p className="ob-rich-card-origin">{ORIGIN_NOTE}</p>
    {actions ? <footer>{actions}</footer> : null}
  </article>
}

/**
 * Addresses one per line, with a count.
 *
 * Joined into a sentence, `person2@example.test, person3@example.test, person4@example.test` reads
 * as one grey blur — and these recipients were chosen by the model, not typed by
 * the user. An address appended after two plausible ones has to be countable,
 * not merely present.
 */
function Recipients({ label, addresses }: { label: string; addresses: string[] }): ReactNode {
  return <>
    <dt>{label}</dt>
    <dd>
      {addresses.length === 0 ? 'Not set' : <ul className="ob-rich-card-people">{addresses.map((address, index) => <li key={`${index}-${address}`}>{address}</li>)}</ul>}
      {addresses.length > 0 ? <span className="ob-rich-card-count">{addresses.length} address{addresses.length === 1 ? '' : 'es'}</span> : null}
    </dd>
  </>
}

export function RichCard({ spec }: { spec: RichCardSpec }): ReactNode {
  const copy = (value: string): void => { void copyText(value).then(() => store.toast('Draft copied.'), () => store.toast('The clipboard is unavailable.', 'error')) }
  if (spec.type === 'email-draft') {
    const full = `To: ${spec.to.join(', ')}${spec.cc?.length ? `\nCc: ${spec.cc.join(', ')}` : ''}\nSubject: ${spec.subject}\n\n${spec.body}`
    /*
     * "Open in mail app", with no send icon and no primary weight: the link only
     * hands the draft to the OS mail client, but a paper plane on a primary
     * button reads as "send now" — over a recipient list the model wrote. Copy
     * takes the primary slot because it is the action that does what it says.
     */
    const actions = <>
      <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" onClick={() => copy(full)}><IconCopy size={11} /> Copy</button>
      <a className="ob-btn ob-btn-sm" href={mailtoUrl(spec)}>Open in mail app</a>
    </>
    return <CardShell kind="Email draft" title={spec.subject || '(no subject)'} actions={actions}>
      <dl>
        <Recipients label="To" addresses={spec.to} />
        {spec.cc?.length ? <Recipients label="Cc" addresses={spec.cc} /> : null}
      </dl>
      <p>{spec.body}</p>
    </CardShell>
  }
  if (spec.type === 'message-draft') {
    const actions = <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" onClick={() => copy(spec.body)}><IconCopy size={11} /> Copy message</button>
    return <CardShell kind={`${spec.service} draft${spec.channel ? ` · ${spec.channel}` : ''}`} title="Ready to review" actions={actions}>
      <p>{spec.body}</p>
    </CardShell>
  }
  /*
   * No host means the URL did not parse, and a card that cannot say where it
   * goes must not offer to go there — the affordance is withheld rather than
   * rendered over an address nobody can check. `parseCard` already refuses such
   * a URL; a card reaching this component by any other route gets the same rule.
   */
  const host = linkHost(spec.url)
  const actions = host ? <a className="ob-btn ob-btn-sm ob-btn-primary" href={spec.url} target="_blank" rel="noreferrer noopener" title={spec.url}>Open link</a> : null
  return <CardShell kind="Link" title={spec.title} actions={actions}>
    <p className="ob-rich-card-host" title={host ? spec.url : undefined}>{host ?? 'This address cannot be read, so the link is not offered.'}</p>
    {spec.description ? <p>{spec.description}</p> : null}
  </CardShell>
}
