import { isAbsolute, relative, sep } from 'node:path'

/** Inputs are canonical paths. Never let a native development child open a
 * live store, and allow a packaged Preview child only its own Preview store. */
export function nativeDataAllowed(data: string, temporaryRoot: string, previewRoot?: string): boolean {
  if (!isAbsolute(data) || !isAbsolute(temporaryRoot)) return false
  const insideTemp = relative(temporaryRoot, data)
  if (insideTemp && insideTemp !== '..' && !insideTemp.startsWith(`..${sep}`) && !isAbsolute(insideTemp)) return true
  return Boolean(previewRoot && data === previewRoot)
}
