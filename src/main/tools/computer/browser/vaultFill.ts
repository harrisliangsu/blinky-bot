/** Build a single same-origin DOM operation; the result never contains the value. */
export function vaultFillExpression(origin: string, field: string, value: string): string {
  const expected: Record<string, string[]> = {
    username: ['username', 'email'], password: ['current-password'],
    holder: ['cc-name'], number: ['cc-number'], expiry: ['cc-exp'], security_code: ['cc-csc'],
    recipient: ['name'], street: ['street-address', 'address-line1'], city: ['address-level2'], region: ['address-level1'], postal_code: ['postal-code'], country: ['country-name', 'country']
  }
  const hints = expected[field]
  if (!hints || !value || value.length > 4096) throw new Error('Unsupported vault field.')
  // The browser evaluates all checks and the fill together, so a navigation
  // between checking the origin and assigning the field cannot redirect it.
  return `(() => { const expectedOrigin=${JSON.stringify(origin)}, hints=${JSON.stringify(hints)}, field=${JSON.stringify(field)}, value=${JSON.stringify(value)};
    if (location.origin !== expectedOrigin || window.top !== window) return false;
    const el = document.activeElement;
    const multiline = typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement;
    if (!(el instanceof HTMLInputElement) && !multiline) return false;
    if (el.disabled || el.readOnly || !el.isConnected) return false;
    const hint = (el.getAttribute('autocomplete') || '').toLowerCase().trim().split(/\\s+/).pop();
    const password = field === 'password' && el.type === 'password' && (!hint || hint === 'current-password');
    if (multiline ? (field !== 'street' || !hints.includes(hint)) : (field === 'password' ? !password : (!hint || !hints.includes(hint) || !['text','email','tel', ...(field === 'expiry' ? ['month'] : [])].includes(el.type)))) return false;
    const setter = Object.getOwnPropertyDescriptor(multiline ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    const previous = el.value;
    setter.call(el, value);
    if (el.value !== value) { setter.call(el, previous); return false; }
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true;
  })()`
}
