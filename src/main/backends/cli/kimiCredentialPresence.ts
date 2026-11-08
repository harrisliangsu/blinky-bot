/** Project native CLI configuration into a presence hint, never an identity proof. */
export function hasKimiProviderCredential(output: string): boolean {
  let value: unknown
  try { value = JSON.parse(output) } catch { return false }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const { models, providers } = value as Record<string, unknown>
  if (!models || typeof models !== 'object' || Array.isArray(models) || !providers || typeof providers !== 'object' || Array.isArray(providers)) return false
  const nonempty = (value: unknown): boolean => typeof value === 'string' && Boolean(value.trim())
  return Object.values(models).some(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
    const model = raw as Record<string, unknown>
    if (!nonempty(model.model) || typeof model.provider !== 'string' || !Object.hasOwn(providers, model.provider)) return false
    const rawProvider = (providers as Record<string, unknown>)[model.provider]
    if (!rawProvider || typeof rawProvider !== 'object' || Array.isArray(rawProvider)) return false
    const provider = rawProvider as Record<string, unknown>
    const inline = nonempty(provider.apiKey ?? provider.api_key)
    const reference = nonempty(provider.apiKeyEnv ?? provider.api_key_env)
    if (provider.oauth !== undefined || inline && reference) return false
    // The CLI resolves declared environment references itself, including a
    // configured launcher whose private environment is not visible to the app.
    // This is the same readiness hint as an OAuth file, not remote validation.
    return inline || reference
  })
}
