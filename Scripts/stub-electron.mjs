// ESM loader hook that stubs the 'electron' module for main-process probes
// running under plain node (tests/benchmarks that pull in app-level modules).
// Usage: node --import ./scripts/stub-electron.mjs --import ./scripts/register-ts.mjs ...
import { register } from 'node:module'

register(new URL('./stub-electron-hooks.mjs', import.meta.url))
