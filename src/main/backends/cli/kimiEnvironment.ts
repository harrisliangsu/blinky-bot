/** Match macOS trust for the Node-based Kimi CLI without disabling TLS checks. */
export function kimiNativeEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  // Explicit trust settings belong to the user. Do not replace their choice.
  const trustKeys = ['NODE_USE_SYSTEM_CA', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
  if (platform !== 'darwin' || trustKeys.some(key => env[key] !== undefined) || /--use-(?:bundled|openssl|system)-ca\b/.test(env.NODE_OPTIONS ?? '')) return env
  return { ...env, NODE_USE_SYSTEM_CA: '1' }
}
