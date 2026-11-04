/**
 * Resolve extensionless relative imports to `.ts` so Node can run the
 * type-stripped unit tests. The app bundle resolves those specifiers itself.
 */

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !/\.(?:[cm]?[jt]s|json|node|css)$/.test(specifier)
  ) {
    return nextResolve(`${specifier}.ts`, context)
  }
  return nextResolve(specifier, context)
}
