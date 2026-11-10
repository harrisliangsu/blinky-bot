/** Explicit new semantics; legacy string lists never change interpretation. */
export interface SemanticPermissionRule {
  id: string
  version: 1
  effect: 'ask' | 'allow'
  text: string
}
export function isSemanticPermissionRule(value: unknown): value is SemanticPermissionRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const rule = value as Record<string, unknown>
  return rule.version === 1 && typeof rule.id === 'string' && !!rule.id && rule.id.length <= 100 &&
    (rule.effect === 'ask' || rule.effect === 'allow') && typeof rule.text === 'string' && !!rule.text.trim() && rule.text.length <= 2000
}
export function hasSemanticPermissionRules(settings: { semanticPermissionRules?: unknown }): boolean {
  return settings.semanticPermissionRules !== undefined &&
    (!Array.isArray(settings.semanticPermissionRules) || settings.semanticPermissionRules.length > 0)
}
