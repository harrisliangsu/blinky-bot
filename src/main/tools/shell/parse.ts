/**
 * Shell command-line parsing.
 *
 * Everything here is lexical: splitting a command into segments, breaking a
 * segment into tokens, and finding the binary a segment actually runs. No
 * judgement about risk is made — that belongs to `classify.ts`, and the
 * destructive-shape rules to `denylist.ts`.
 */

/** Split on shell operators while ignoring anything inside quotes. */
export function splitSegments(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      current += ch
      if (ch === quote && command[i - 1] !== '\\') quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      out.push(current)
      current = ''
      i++
      continue
    }
    if (ch === '&' && (command[i - 1] === '>' || /\d/.test(command[i + 1] ?? ''))) {
      current += ch // file-descriptor redirect such as 2>&1, not an operator
      continue
    }
    if (ch === ';' || ch === '|' || ch === '\n' || ch === '&') {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)
  return out.map((s) => s.trim()).filter(Boolean)
}

export function tokenize(segment: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (quote) {
      if (ch === quote && segment[i - 1] !== '\\') quote = undefined
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current) tokens.push(current)
  return tokens
}

/**
 * The command with shell quoting and backslash escapes removed.
 *
 * Pattern rules match text, but the shell matches *after* it has removed
 * quotes: `rm -rf "/"` and `rm -rf /` do exactly the same thing, so a rule that
 * only ever saw the raw string was one character away from being bypassed —
 * `rm -rf '/'`, `rm -rf "/etc"` and `dd of="/dev/disk0"` all sailed through.
 */
export function unquote(command: string): string {
  let out = ''
  let quote: '"' | "'" | undefined
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      // Inside single quotes a backslash is literal; inside double quotes it escapes.
      if (quote === '"' && ch === '\\' && i + 1 < command.length) {
        out += command[++i]
        continue
      }
      if (ch === quote) quote = undefined
      else out += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '\\' && i + 1 < command.length) {
      out += command[++i]
      continue
    }
    out += ch
  }
  return out
}

const WRAPPERS = new Set(['sudo', 'command', 'env', 'nohup', 'time', 'nice', 'xargs', 'exec', 'builtin', 'doas'])

function wrapperName(token: string): string | undefined {
  const base = token.includes('/') ? (token.split('/').pop() ?? token) : token
  return WRAPPERS.has(base) ? base : undefined
}

/**
 * Wrapper flags that consume the token after them.
 *
 * Skipping flags one at a time reported `nice -n 5 rm -rf x` as the binary `5`,
 * which the risk classifier reads as an unknown command rather than as `rm` —
 * softening the prompt for the command actually being run. Attached forms
 * (`-n5`, `--adjustment=5`) are already a single token and need no entry.
 */
const WRAPPER_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  nice: new Set(['-n', '--adjustment']),
  sudo: new Set(['-u', '-g', '-p', '-C', '-U', '-T', '-R', '-D', '--user', '--group', '--prompt']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir']),
  xargs: new Set(['-n', '-P', '-I', '-L', '-s', '-E', '-a', '-d', '--max-args', '--max-procs']),
  time: new Set(['-o', '-f', '--output', '--format'])
}

export interface HeadBinary {
  binary: string
  args: string[]
  viaSudo: boolean
}

/**
 * The tokens a segment really runs, with leading `NAME=value` assignments and
 * wrappers such as `env`, `nohup` or `sudo` removed.
 *
 * Path-qualified wrappers count too: `/usr/bin/sudo gh …` is still `sudo`.
 * `FOO=1 sudo rm` therefore reports `rm` rather than the assignment or the wrapper.
 */
export function commandTokens(tokens: string[]): { tokens: string[]; viaSudo: boolean } | undefined {
  let viaSudo = false
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      i++
      continue
    }
    const wrapper = wrapperName(token)
    if (wrapper) {
      if (wrapper === 'sudo' || wrapper === 'doas') viaSudo = true
      const takesValue = WRAPPER_VALUE_FLAGS[wrapper] ?? new Set<string>()
      i++
      // Skip the wrapper's own flags, and the value of any flag that takes one.
      while (i < tokens.length && (tokens[i] ?? '').startsWith('-')) {
        const flag = tokens[i] ?? ''
        i++
        if (takesValue.has(flag) && i < tokens.length) i++
      }
      continue
    }
    return { tokens: tokens.slice(i), viaSudo }
  }
  return undefined
}

/**
 * The binary a segment really invokes: leading `NAME=value` assignments and
 * wrappers such as `env`, `nohup` or `sudo` are stepped over, so `FOO=1 sudo rm`
 * reports `rm` rather than the assignment or the wrapper.
 */
export function headBinary(tokens: string[]): HeadBinary | undefined {
  const invoked = commandTokens(tokens)
  if (!invoked) return undefined
  const token = invoked.tokens[0] ?? ''
  const binary = token.includes('/') ? (token.split('/').pop() ?? token) : token
  return { binary, args: invoked.tokens.slice(1).filter((arg) => !arg.startsWith('-')), viaSudo: invoked.viaSudo }
}
