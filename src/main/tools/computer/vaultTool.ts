import type { ToolContext } from '../types'
import type { ToolResult } from '../../../shared/types'
import { listVaultItems, useVaultField, vaultItemId } from '../../store/vault'
import { withComputerAuthorization } from './gate'

/** The model supplies an opaque reference; decryption happens only after approval. */
export async function fillVaultReference(reference: string, field: string, ctx: ToolContext): Promise<ToolResult> {
  if (!reference.startsWith('vault://ref/')) throw new Error('Use an opaque vault reference.')
  const id = vaultItemId(reference)
  const item = (await listVaultItems()).find(item => item.id === id)
  if (!item?.origin || !item.fields.includes(field)) throw new Error('The vault reference, site or field is unavailable.')
  const filled = await withComputerAuthorization(ctx, {
    toolName: 'type_text', summary: `Fill saved ${field} on ${item.origin}`,
    detail: `Reference: ${reference}\nField: ${field}\nWebsite: ${item.origin}\nFill the matching focused field only. Does not submit or return the value or a screenshot. The website and subsequent browser actions may read the filled value.`
  }, async provider => {
    const browser = provider as typeof provider & { fillVaultField?: (origin: string, field: string, value: string) => Promise<boolean> }
    if (!browser.fillVaultField) return false
    return useVaultField(reference, field, async (origin, value) => origin === item.origin && !ctx.signal.aborted && browser.fillVaultField!(origin, field, value))
  })
  return { callId: ctx.callId ?? '', name: 'type_text', ok: filled, output: filled ? 'Filled the matching field from the vault reference. No value or screenshot returned.' : 'Not filled. Check the website and focused field.', detail: { reference, field, filled } }
}
