import { bridge, errText } from './bridge'
import { store } from './core'
import type { Routine } from '../../../shared/types'

export async function loadRoutines(botId?: string): Promise<void> {
  try {
    store.patch({ routines: await bridge().routines.list(botId), routinesError: null })
  } catch (e) {
    store.patch({ routinesError: errText(e) })
  }
}

export async function runRoutine(routineId: string): Promise<void> {
  const sessionId = store.getState().currentSessionId
  if (!sessionId) {
    store.toast('Open a conversation first — routines run inside one.', 'error')
    return
  }
  try {
    await bridge().routines.run(routineId, sessionId)
    store.setModal(null)
  } catch (e) {
    store.toast(errText(e), 'error')
  }
}

export async function removeRoutine(id: string): Promise<void> {
  try {
    await bridge().routines.remove(id)
    store.patch({ routines: store.getState().routines.filter((r) => r.id !== id) })
  } catch (e) {
    store.toast(errText(e), 'error')
  }
}

export async function updateRoutine(id: string, patch: Partial<Routine>): Promise<void> {
  try {
    const updated = await bridge().routines.update(id, patch)
    if (!updated) { store.toast('Could not save the routine.', 'error'); return }
    store.patch({ routines: store.getState().routines.map((routine) => routine.id === id ? updated : routine) })
  } catch (e) {
    store.toast(errText(e), 'error')
  }
}

export async function startRecording(botId: string, name: string): Promise<void> {
  const clean = name.trim() || 'Untitled routine'
  store.patch({ recording: { state: 'recording', stepCount: 0, steps: [], botId, name: clean } })
  try {
    await bridge().routines.startRecording(botId, clean)
  } catch (e) {
    store.patch({ recording: { state: 'idle', stepCount: 0, steps: [], botId, name: clean } })
    store.toast(errText(e), 'error')
  }
}

export async function stopRecording(): Promise<void> {
  const { recording, routines } = store.getState()
  try {
    const routine = await bridge().routines.stopRecording()
    store.patch({
      recording: { state: 'idle', stepCount: 0, steps: [], botId: recording.botId, name: '' },
      routines: routine ? [...routines.filter((r) => r.id !== routine.id), routine] : routines
    })
  } catch (e) {
    store.patch({ recording: { ...recording, state: 'idle' } })
    store.toast(errText(e), 'error')
  }
}
