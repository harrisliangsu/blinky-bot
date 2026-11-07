export type VoiceError = 'interaction-required' | 'microphone-permission' | 'speech-permission' | 'microphone-unavailable' | 'unavailable' | 'helper-unavailable' | 'host-required' | 'recognition' | 'no-speech' | 'busy'
export interface VoiceStatus { speech: string; microphone: string; onDevice: boolean; language: string; failure?: 'helper-unavailable' | 'host-required' }
export interface VoiceEvent { id: string; type: 'starting' | 'listening' | 'stopping' | 'interim' | 'result' | 'error' | 'end'; text?: string; code?: VoiceError }
export interface VoiceReply { ok: boolean; error?: VoiceError }
export type VoiceLanguageSaveResult = { ok: true; language: string } | { ok: false; error: string }
