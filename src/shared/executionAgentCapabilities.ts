/** pi is a model client; its tools run through the application's own loop. */
export function usesApplicationToolLoop(backendId: string): boolean {
  return backendId === 'pi'
}

/** Other CLI adapters need a runtime gateway to delegate. */
export function supportsExecutionDelegation(backendId: string): boolean {
  return backendId !== 'droid'
}
