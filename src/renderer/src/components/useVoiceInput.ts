import { useEffect, useRef, useState } from 'react'
import type { VoiceEvent } from '../../../shared/voice'
import { voiceError } from '../lib/voice'

/** A recording belongs to its originating draft. Only a final result edits text. */
export function useVoiceInput(owner: string | undefined, language: string, zh: boolean, onSpoken: (spoken: string) => void) {
  const [state, setState] = useState<'idle' | 'starting' | 'listening' | 'stopping'>('idle')
  const [interim, setInterim] = useState('')
  const [error, setError] = useState('')
  const run = useRef<{ id: string; owner: string | undefined } | null>(null)
  const currentOwner = useRef(owner); currentOwner.current = owner
  const callback = useRef(onSpoken); callback.current = onSpoken
  const cancel = (): void => {
    const active = run.current; run.current = null
    if (active) void window.openbot.voice.stop(active.id, true)
    setState('idle'); setInterim(''); setError('')
  }
  useEffect(() => {
    setState('idle'); setInterim(''); setError('')
    const off = window.openbot.voice.on((event: VoiceEvent) => {
      const active = run.current
      if (!active || active.id !== event.id || active.owner !== currentOwner.current) return
      if (event.type === 'starting' || event.type === 'listening' || event.type === 'stopping') setState(event.type)
      if (event.type === 'interim') setInterim(event.text ?? '')
      if (event.type === 'result' && event.text?.trim()) callback.current(event.text.trim())
      if (event.type === 'error') setError(voiceError(event.code, zh))
      if (event.type === 'end') { run.current = null; setState('idle'); setInterim('') }
    })
    return () => { off(); const active = run.current; run.current = null; if (active) void window.openbot.voice.stop(active.id, true) }
  }, [owner, language, zh])
  const toggle = (): void => {
    const active = run.current
    if (active) {
      if (state !== 'listening') { cancel(); return }
      setState('stopping'); void window.openbot.voice.stop(active.id); return
    }
    if (!owner) return
    const id = crypto.randomUUID(); run.current = { id, owner }
    setError(''); setInterim(''); setState('starting')
    void window.openbot.voice.start(id, language).then((reply) => {
      if (run.current?.id !== id) return
      if (!reply.ok) { run.current = null; setState('idle'); setError(voiceError(reply.error, zh)) }
    }).catch(() => {
      if (run.current?.id !== id) return
      run.current = null; setState('idle'); setError(voiceError('recognition', zh))
    })
  }
  return { state, interim, error, busy: state !== 'idle', listening: state === 'listening', toggle, cancel }
}
