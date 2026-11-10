/** Conservative recognition of user-authored, durable workflow preferences. */
import { screenUserPreference } from './memoryFilter'
import { addUserPreference, listUserPreferences } from '../store/memory'

// These markers must appear at the start of the user's own message. Do not
// extract instructions from pasted text, agent output, a bare confirmation, or
// ordinary requests for the current task.
const EXPLICIT_PREFERENCE = /^(?:请)?(?:重新记住|再次记住|记住|牢记|以后|今后|后续|从今以后|从现在起|今后都|长期|一直都|永远|每次都|我的长期偏好|我的工作流程|我们的工作流程|我(?:以后|今后|长期|的习惯)|(?:请)?(?:remember|always|never|going forward|from now on|for future)\b)/i
const QUOTED_OR_EMBEDDED = /```|[“”「」『』]|(?:^|\n)\s*>|<\/?(?:system|assistant|user|tool)\b/i

// Direct corrections can state a durable preference without "以后". Require
// a clear replacement rather than interpreting a standalone "不要" as a
// permanent rule, and exclude requests explicitly scoped to the current task.
const EXPLICIT_CORRECTION = /^(?:请)?(?:不(?:要|用)|别)(?:再|把)?[^，。；\n]{2,60}[，,；;]\s*(?:只|改为|改成|应该|需要|以后|而是)[^。；\n]{2,}/
const DEFAULT_PREFERENCE = /^(?:请)?默认(?:应该|应当|应|需要|要|使用|采用|开启|关闭|显示|不显示)[^\n]{4,}/
const ONE_OFF = /(?:这次|本次|当前|现在|今天|这条|这一个|这一份|这轮|此刻|本轮)/

export function userPreferenceCandidate(message: string): string | null {
  const raw = message.trim()
  // A durable correction may be one paragraph within a longer request. Do
  // not reinterpret quoted or embedded third-party text as a user preference.
  if (QUOTED_OR_EMBEDDED.test(raw)) return null
  for (const line of raw.split(/\n+/).map((part) => part.trim()).filter(Boolean)) {
    const explicit = EXPLICIT_PREFERENCE.test(line)
    const correction = (EXPLICIT_CORRECTION.test(line) || DEFAULT_PREFERENCE.test(line)) && !ONE_OFF.test(line)
    if (!explicit && !correction) continue
    const screened = screenUserPreference(line)
    if (screened.ok && screened.text) return screened.text
  }
  return null
}

// Serialize deduplication and writes: a queued message can also later be added
// to the transcript, and two quick sends can arrive at the same time.
let preferenceWrites: Promise<void> = Promise.resolve()

export async function captureUserPreference(message: string, messageId?: string): Promise<void> {
  const candidate = userPreferenceCandidate(message)
  if (!candidate) return
  const operation = preferenceWrites.then(async () => {
    // A queued message is revisited when it enters the transcript. Its id,
    // unlike its text, remains stable even after another correction arrives.
    const existing = listUserPreferences()
    if (messageId && existing.some((entry) => entry.tags?.includes(`message:${messageId}`))) return
    if (!messageId && existing.at(-1)?.text === candidate) return
    await addUserPreference(candidate, messageId)
  })
  preferenceWrites = operation.catch(() => undefined)
  try {
    await operation
  } catch (error) {
    // A failed memory write must not reject or duplicate a chat message.
    console.warn('[openbot/memory] could not save user preference:', error instanceof Error ? error.message : String(error))
  }
}
