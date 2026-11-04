import { useEffect, useRef, useState } from 'react'
import { startVoiceInput, type VoiceSession } from '../lib/voice'
import { store } from '../state'

export interface VoiceInput {
  listening: boolean
  /** What is being said right now — settled text goes to the message instead. */
  interim: string
  toggle: () => void
}

/** Dictation into the composer, for as long as it is switched on. */
export function useVoiceInput(onSpoken: (spoken: string) => void): VoiceInput {
  const [listening, setListening] = useState(false)
  const [voiceInterim, setVoiceInterim] = useState('')
  const voice = useRef<VoiceSession | null>(null)

  useEffect(() => () => voice.current?.stop(), [])

  const toggleVoice = (): void => {
    if (listening) {
      voice.current?.stop()
      voice.current = null
      setListening(false)
      setVoiceInterim('')
      return
    }
    const session = startVoiceInput({
      result: (spoken, final) => {
        if (final) {
          onSpoken(spoken)
          setVoiceInterim('')
        } else setVoiceInterim(spoken)
      },
      error: (message) => store.toast(message, 'error'),
      end: () => { voice.current = null; setListening(false); setVoiceInterim('') }
    })
    /*
     * Null means voice input declined to start — which it always does, by
     * design: Chromium's recogniser streams audio to Google and the app denies
     * the microphone (see lib/voice.ts). The fallback names something that works
     * and stays on the machine, instead of a Web Speech error code.
     */
    if (!session) {
      store.toast('Voice input is off — BlinkyBot will not stream your audio to a speech service. You can still use macOS Dictation in the message field.', 'error')
      return
    }
    voice.current = session
    setListening(true)
  }

  return { listening, interim: voiceInterim, toggle: toggleVoice }
}
