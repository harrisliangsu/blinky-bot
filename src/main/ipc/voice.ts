import type { VoiceReply } from '../../shared/voice'
import { handleEvent } from './handler'
import { startVoice, controlVoice, voiceStatus } from '../voice'
import { getSettings, saveVoiceLanguage } from '../settings'
export function registerVoiceIpc(): void {
  handleEvent<import('../../shared/voice').VoiceLanguageSaveResult>('openbot:voice:language', async (_event, [language]) => ({ ok: true, language: await saveVoiceLanguage(language) }), () => ({ ok: false, error: '语音语言未能保存，请重试。 / Voice language could not be saved. Try again.' }))
  // Event handlers deliberately do not expose recording to the Agent/native bridge.
  handleEvent('openbot:voice:status', (_event, [language]) => voiceStatus(language), () => ({ speech: 'unavailable', microphone: 'unknown', onDevice: false, language: '' }))
  handleEvent<VoiceReply>('openbot:voice:start', async (event, [id]) => {
    if (!event.sender.isFocused() || !await event.senderFrame?.executeJavaScript('navigator.userActivation.isActive')) return { ok: false, error: 'interaction-required' }
    return startVoice(event.sender, id, getSettings().voiceLanguage)
  }, () => ({ ok: false, error: 'unavailable' as const }))
  handleEvent('openbot:voice:stop', (event, [id, cancel]) => controlVoice(event.sender, id, cancel === true), () => undefined)
}
