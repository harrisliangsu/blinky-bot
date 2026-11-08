import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasKimiProviderCredential } from './kimiCredentialPresence.ts'
import { kimiNativeEnvironment } from './kimiEnvironment.ts'

test('Kimi macOS runtime uses system trust while preserving explicit trust choices and other platforms', () => {
  const source = { HOME: '/synthetic', HTTPS_PROXY: 'https://proxy.invalid', KIMI_CODE_HOME: '/synthetic/config' }
  assert.deepEqual(kimiNativeEnvironment(source, 'darwin'), { ...source, NODE_USE_SYSTEM_CA: '1' })
  assert.equal(Object.hasOwn(source, 'NODE_USE_SYSTEM_CA'), false)
  assert.equal(kimiNativeEnvironment(source, 'linux'), source)
  assert.equal(kimiNativeEnvironment(source, 'win32'), source)
  for (const explicit of [{ NODE_USE_SYSTEM_CA: '0' }, { NODE_EXTRA_CA_CERTS: '/custom/roots.pem' }, { SSL_CERT_FILE: '/custom/roots.pem' }, { SSL_CERT_DIR: '/custom' }, { NODE_OPTIONS: '--use-bundled-ca' }, { NODE_OPTIONS: '--use-openssl-ca' }, { NODE_OPTIONS: '--use-system-ca' }]) {
    const env = { ...source, ...explicit }
    assert.equal(kimiNativeEnvironment(env, 'darwin'), env)
  }
  assert.equal(kimiNativeEnvironment(source, 'darwin').NODE_TLS_REJECT_UNAUTHORIZED, undefined)
})

test('Kimi provider readiness supports API keys and native env references without exposing a credential', () => {
  const document = (provider: unknown) => JSON.stringify({ providers: { selected: provider }, models: { alias: { provider: 'selected', model: 'synthetic' } } })
  assert.equal(hasKimiProviderCredential(document({ apiKey: 'synthetic-private-key' })), true)
  assert.equal(hasKimiProviderCredential(document({ api_key: 'synthetic-private-key' })), true)
  assert.equal(hasKimiProviderCredential(document({ apiKeyEnv: 'SYNTHETIC_PRIVATE_ENV' })), true)
  assert.equal(hasKimiProviderCredential(document({ api_key_env: 'SYNTHETIC_PRIVATE_ENV' })), true)
  assert.equal(hasKimiProviderCredential(document({ apiKey: '' })), false)
  assert.equal(hasKimiProviderCredential(document({ apiKey: 'x', apiKeyEnv: 'OTHER' })), false)
  assert.equal(hasKimiProviderCredential(document({ apiKey: 'x', oauth: {} })), false)
  assert.equal(hasKimiProviderCredential(JSON.stringify({ providers: { orphan: { apiKey: 'x' } }, models: { alias: { provider: 'missing', model: 'x' } } })), false)
  assert.equal(hasKimiProviderCredential('invalid'), false)
  assert.equal(hasKimiProviderCredential(document([])), false)
  assert.equal(hasKimiProviderCredential(document({})), false)
})
