import type { VoiceError } from '../../../shared/voice'
/** No provider keys or cloud fallback: messages describe actual local failures. */
export function voiceError(code: VoiceError | undefined, zh: boolean): string {
  const messages: Record<VoiceError, [string, string]> = {
    'interaction-required': ['请在当前窗口点击麦克风开始语音输入。', 'Click the microphone in the current window to start voice input.'],
    'microphone-permission': ['麦克风未获允许。请在系统设置的隐私与安全性中允许 BlinkyBot 使用麦克风后重试。', 'Allow BlinkyBot microphone access in System Settings → Privacy & Security, then try again.'],
    'speech-permission': ['语音识别未获允许。请在系统设置的隐私与安全性中允许 BlinkyBot 使用语音识别后重试。', 'Allow BlinkyBot speech recognition in System Settings → Privacy & Security, then try again.'],
    'microphone-unavailable': ['无法使用麦克风。请检查输入设备后重试。', 'The microphone is unavailable. Check your input device and try again.'],
    unavailable: ['当前语言的本地语音识别不可用。请在系统设置中启用听写并下载该语言，或更换语音语言。', 'On-device speech recognition is unavailable for this language. Enable Dictation and download the language in System Settings, or choose another language.'],
    'helper-unavailable': ['本地语音服务未能响应，暂时无法确认识别可用性。输入草稿保留；请检查应用后重试。', 'The native speech service did not respond, so recognition availability could not be confirmed. Your draft is kept. Check the app and try again.'],
    'host-required': ['本机语音输入请在 Mac 客户端使用；此局域网页面不会请求麦克风。', 'Use the Mac client for on-device dictation. This LAN page does not request microphone access.'],
    recognition: ['本地识别未能完成。草稿已保留，请重试。不会改用在线识别。', 'On-device recognition could not finish. Your draft is kept. Try again; audio is never sent to an online service.'],
    'no-speech': ['未识别到语音，草稿未改变。', 'No speech was recognized. Your draft is unchanged.'],
    busy: ['语音输入正在使用中。', 'Voice input is already in use.']
  }
  return messages[code ?? 'recognition'][zh ? 0 : 1]
}
