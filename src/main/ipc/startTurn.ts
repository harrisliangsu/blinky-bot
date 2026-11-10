/** Accept a started task without holding the renderer until it finishes. */
export function startTurn(run: () => Promise<void> | void, onError: (error: unknown) => void): boolean {
  try {
    void Promise.resolve(run()).catch(onError)
    return true
  } catch (error) {
    onError(error)
    return false
  }
}
