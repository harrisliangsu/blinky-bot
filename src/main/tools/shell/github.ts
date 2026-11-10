/**
 * `gh` is installed and authenticated for the whole machine, and the shell
 * tool is on by default. A moderate classification lets auto-run execute it
 * with no card, which posts a GitHub comment without `github_comment_draft`.
 *
 * Comment posts are refused outright. Other GitHub writes have no first-party
 * draft yet, so they stay high risk and always confirm. Reads stay moderate.
 */

import { commandTokens, splitSegments, tokenize } from './parse'

/** Model-facing reason. The shell tool and the CLI callback both key off the tool name. */
export const GITHUB_COMMENT_BLOCK =
  'a GitHub comment posted from the shell. Use github_comment_draft instead of gh, and do not post the comment another way'

export type GhEffect = 'read' | 'write' | 'comment'

const SUBCOMMAND_GROUPS = new Set([
  'pr', 'issue', 'repo', 'repo/deploy-key', 'repo/gitignore', 'repo/license',
  'search', 'release', 'gist', 'run', 'workflow', 'secret', 'variable', 'label',
  'ssh-key', 'gpg-key', 'cache', 'auth', 'config', 'alias', 'extension',
  'project', 'ruleset', 'attestation', 'codespace', 'org', 'preview'
])

/** Read-only `gh` paths. Anything unlisted is treated as a write. */
const READ = new Set([
  'status', 'browse', 'completion', 'help', 'version',
  'search', 'search/code', 'search/commits', 'search/issues', 'search/prs', 'search/repos',
  'pr', 'pr/view', 'pr/list', 'pr/status', 'pr/diff', 'pr/checks', 'pr/checkout',
  'issue', 'issue/view', 'issue/list', 'issue/status',
  'release', 'release/view', 'release/list', 'release/download',
  'repo', 'repo/view', 'repo/list', 'repo/clone',
  'repo/gitignore', 'repo/gitignore/list', 'repo/gitignore/view',
  'repo/license', 'repo/license/list', 'repo/license/view',
  'repo/deploy-key/list',
  'gist', 'gist/view', 'gist/list',
  'run', 'run/view', 'run/list', 'run/watch', 'run/download',
  'workflow', 'workflow/view', 'workflow/list',
  'secret/list', 'variable/list', 'label/list', 'ssh-key/list', 'gpg-key/list', 'cache/list',
  'auth/status', 'config/get', 'config/list', 'alias/list',
  'extension', 'extension/list', 'extension/browse',
  'project', 'project/list', 'project/view',
  'ruleset', 'ruleset/list', 'ruleset/view', 'ruleset/check',
  'attestation', 'attestation/verify', 'attestation/download',
  'org', 'org/list',
  'codespace', 'codespace/list', 'codespace/view', 'codespace/logs', 'codespace/ports',
  'preview'
])

const COMMENT = new Set(['pr/comment', 'issue/comment'])

const API_VALUE_FLAGS = new Set([
  '-H', '--header', '--hostname', '-q', '--jq', '-t', '--template', '-p', '--preview', '--cache', '-R', '--repo'
])
const API_INPUT_FLAGS = new Set(['-f', '--raw-field', '-F', '--field', '--input'])

function binaryName(token: string): string {
  const base = token.includes('/') || token.includes('\\') ? (token.split(/[/\\]/).pop() ?? token) : token
  return base.toLowerCase().replace(/\.exe$/, '')
}

function attachedValue(token: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    if (token.startsWith(`${name}=`)) return token.slice(name.length + 1)
    if (name.startsWith('-') && !name.startsWith('--') && token.startsWith(name) && token.length > name.length && !token.includes('=')) {
      return token.slice(name.length)
    }
  }
  return undefined
}

function pathParts(endpoint: string): string[] {
  let path = endpoint.trim().replace(/^https?:\/\/[^/\s]+/i, '')
  path = path.split(/[?#]/)[0] ?? ''
  try { path = decodeURIComponent(path) } catch { /* a broken escape is still matched raw */ }
  return path.split('/').filter(Boolean).map((part) => part.toLowerCase())
}

function parseApi(rest: string[]): GhEffect {
  let method = ''
  let implicitPost = false
  const positionals: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? ''
    if (token === '--') {
      positionals.push(...rest.slice(i + 1))
      break
    }
    const methodValue = attachedValue(token, ['-X', '--method'])
    if (token === '-X' || token === '--method') {
      method = (rest[++i] ?? '').toUpperCase()
      continue
    }
    if (methodValue !== undefined) {
      method = methodValue.toUpperCase()
      continue
    }
    const inputValue = attachedValue(token, [...API_INPUT_FLAGS])
    if (API_INPUT_FLAGS.has(token) || inputValue !== undefined) {
      implicitPost = true
      if (inputValue === undefined) i++
      continue
    }
    const flagValue = attachedValue(token, [...API_VALUE_FLAGS])
    if (API_VALUE_FLAGS.has(token)) {
      i++
      continue
    }
    if (flagValue !== undefined || token.startsWith('-')) continue
    positionals.push(token)
  }

  const effective = method || (implicitPost ? 'POST' : 'GET')
  const mutating = effective !== 'GET' && effective !== 'HEAD'
  const endpoint = positionals.find((part) => part !== 'graphql') ?? ''
  const graphql = positionals.some((part) => part === 'graphql' || /\/graphql$/i.test(part))
  const commentMutation = graphql && /\b(?:add|update|delete|minimize|unminimize)[A-Za-z]*Comment\b/.test(rest.join('\n'))
  const commentPath = pathParts(endpoint).includes('comments')
  if ((commentPath && mutating) || commentMutation) return 'comment'
  return mutating ? 'write' : 'read'
}

function parseCommand(argv: string[]): { command: string[]; rest: string[] } {
  let i = 0
  const command: string[] = []
  while (i < argv.length && command.length === 0) {
    const token = argv[i] ?? ''
    if (token === '--') {
      i++
      break
    }
    if (token === '--help' || token === '-h' || token === '--version') return { command: ['help'], rest: [] }
    if (token.startsWith('--repo=') || token.startsWith('--hostname=')) {
      i++
      continue
    }
    if (token === '-R' || token === '--repo' || token === '--hostname') {
      i += 2
      continue
    }
    if (token.startsWith('-R') && token.length > 2) {
      i++
      continue
    }
    if (token.startsWith('-')) {
      i++
      continue
    }
    break
  }
  while (i < argv.length && command.length < 3) {
    const token = argv[i] ?? ''
    if (token === '--' || token.startsWith('-')) break
    if (!/^[a-z][a-z0-9-]*$/.test(token)) break
    if (command.length > 0 && !SUBCOMMAND_GROUPS.has(command.join('/'))) break
    command.push(token)
    i++
  }
  return { command, rest: argv.slice(i) }
}

export function ghEffectOfArgv(argv: string[]): GhEffect {
  if (argv.length === 0) return 'read'
  const { command, rest } = parseCommand(argv)
  if (command.length === 0) return 'read'
  if (command[0] === 'api') return parseApi(rest)
  const key = command.join('/')
  if (COMMENT.has(key)) return 'comment'
  if (READ.has(key)) return 'read'
  if (command.length === 1 && SUBCOMMAND_GROUPS.has(command[0] ?? '')) return 'read'
  return 'write'
}

/** What this segment's real `gh` invocation does, after wrappers and assignments. */
export function ghEffect(tokens: string[]): GhEffect | undefined {
  const invoked = commandTokens(tokens)
  if (!invoked) return undefined
  const [binary, ...argv] = invoked.tokens
  if (!binary || binaryName(binary) !== 'gh') return undefined
  return ghEffectOfArgv(argv)
}

function postsComment(text: string): boolean {
  if (!text.trim()) return false
  for (const segment of splitSegments(text)) {
    if (ghEffect(tokenize(segment)) === 'comment') return true
  }
  return false
}

/**
 * An inline program that actually launches `gh` to post a comment.
 *
 * Mentioning the command is not enough — `print("gh pr comment")` does not
 * post — but `os.system("gh pr comment …")` and `["gh","pr","comment"]` do.
 */
export function inlineSourcePostsComment(source: string): boolean {
  if (postsComment(source)) return true
  const literals = [...source.matchAll(/'((?:\\'|[^'])*)'|"((?:\\"|[^"])*)"/g)].map((match) =>
    (match[1] ?? match[2] ?? '').replace(/\\(.)/g, '$1')
  )
  for (const literal of literals) {
    if (postsComment(literal)) {
      if (/\b(system|exec|popen|subprocess|spawn|check_call|check_output|Popen)\b/.test(source)) return true
    }
  }
  if (!/\b(system|exec|popen|subprocess|spawn|check_call|check_output|Popen)\b/.test(source)) return false
  for (let i = 0; i < literals.length; i++) {
    if (binaryName(literals[i] ?? '') !== 'gh') continue
    if (ghEffectOfArgv(literals.slice(i + 1, i + 13)) === 'comment') return true
  }
  return false
}
