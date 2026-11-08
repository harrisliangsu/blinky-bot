/**
 * Resolve extensionless relative imports to `.ts` so Node can run the
 * type-stripped unit tests. The app bundle resolves those specifiers itself.
 */

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !/\.(?:[cm]?[jt]s|json|node|css)$/.test(specifier)
  ) {
    try { return await nextResolve(`${specifier}.ts`, context) }
    catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
      return nextResolve(`${specifier}/index.ts`, context)
    }
  }
  return nextResolve(specifier, context)
}
