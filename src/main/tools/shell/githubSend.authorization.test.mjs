import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Real shell classification, shell tool and CLI approval callback. execCapture
// and the approval gate are boundaries: a comment post must not reach either,
// and a non-comment gh write must not be auto-approved. No gh binary, network
// or Electron process is used. The Bot under test does not have
// github_comment_draft — the refusal must not depend on that grant.
const shellDir = dirname(fileURLToPath(import.meta.url))
const bundle = await build({
  stdin: {
    contents: `export { shellTool } from './index.ts'; export { analyzeCommand } from './classify.ts'; export { buildChatRequest } from '../../agent/chatRequest.ts'; export { evaluate } from '../../agent/approvalPolicy.ts'; export { defaultSettings } from '../../settingsSchema.ts'`,
    resolveDir: shellDir,
    loader: 'ts'
  },
  bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'gh-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) => {
      if (args.path === '../exec' && args.importer.endsWith('/tools/shell/index.ts')) return { path: 'exec', namespace: 'gh' }
      if (args.path === './approval' && args.importer.endsWith('/agent/chatRequest.ts')) return { path: 'approval', namespace: 'gh' }
      if (args.path === '../tasks/clarifications' && args.importer.endsWith('/agent/chatRequest.ts')) return { path: 'clarify', namespace: 'gh' }
      if (args.path === '../store/mcpSecrets' && args.importer.endsWith('/agent/chatRequest.ts')) return { path: 'secrets', namespace: 'gh' }
      return undefined
    })
    builder.onLoad({ filter: /.*/, namespace: 'gh' }, (args) => ({
      contents: {
        exec: `export async function execCapture(...args) { globalThis.__ghBypass.execs.push(args); return { code: 0, signal: null, stdout: 'must-not-run', stderr: '', timedOut: false, aborted: false, durationMs: 1 } }`,
        approval: `export async function requestApproval(ask) { globalThis.__ghBypass.cliApprovals.push(ask); if (ask.force === true) return { approved: false, reason: 'confirmation required' }; return { approved: true, reason: 'auto-run', decision: 'approve-always' } }`,
        clarify: `export async function requestTaskClarification() { return null }`,
        secrets: `export function mcpBearerToken() { return undefined }`
      }[args.path],
      loader: 'js'
    }))
  }}]
})
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`)

const root = await mkdtemp(join(tmpdir(), 'blinky-gh-send-'))
const shell = join(root, 'noop-shell.sh')
await writeFile(shell, '#!/bin/sh\nexit 0\n')
await chmod(shell, 0o755)
process.env.SHELL = shell

function state() {
  globalThis.__ghBypass = { execs: [], cliApprovals: [] }
  return globalThis.__ghBypass
}
function autoSettings(extra = {}) {
  return { ...api.defaultSettings(), approvalPolicy: 'auto-run', allowlist: [], denylist: [], asklist: [], automaticReview: true, ...extra }
}
const opened = ['*', 'gh *', 'gh pr *', 'gh pr comment *', 'gh issue comment *', 'tool:shell']

async function runShell(command, settings = autoSettings()) {
  const prompts = []
  const ctx = {
    sessionId: 'fixture-session', botId: 'coder', cwd: root,
    signal: new AbortController().signal, emit() {}, settings,
    async requestApproval(request) {
      prompts.push(request)
      return api.evaluate(settings, 'shell', command, new Set(), request.force === true).outcome === 'allow'
    }
  }
  const result = await api.shellTool.handler({ command }, ctx)
  return { result, prompts }
}

const bot = {
  id: 'coder', name: 'Coder', backendId: 'codex', modelId: 'fixture', systemPrompt: 'fixture',
  tools: ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'shell', 'fetch', 'todo_write', 'remember', 'handoff', 'delegate_task', 'request_help'],
  computerUse: false, computerTarget: { kind: 'local' }
}
function chat(settings = autoSettings()) {
  return api.buildChatRequest({
    session: { id: 'fixture-session', mode: 'agent', cwd: root, botIds: [bot.id] },
    bot, settings, signal: new AbortController().signal, mode: 'supervised', messages: [], tools: []
  })
}
async function cli(command, settings) {
  const request = chat(settings)
  return request.approve({
    kind: 'shell',
    summary: `Codex wants to run: ${command}`,
    detail: command,
    target: command
  })
}

const comments = [
  'gh pr comment 12 --body hello',
  'gh issue comment 4 --body hello',
  'gh api --method POST repos/octocat/hello/issues/1/comments -f body=hello',
  'gh api -X POST /repos/octocat/hello/issues/1/comments',
  'gh api repos/octocat/hello/issues/1/comments -f body=hello',
  'gh api --method=PUT repos/octocat/hello/issues/comments/9 -f body=edited',
  'gh api -X DELETE repos/octocat/hello/issues/comments/9',
  'gh api --method POST https://api.github.com/repos/octocat/hello/issues/1/comments -f body=hello',
  "gh api graphql -f query='mutation { addComment(input: {subjectId: \"x\", body: \"hi\"}) { clientMutationId } }'",
  'sudo gh pr comment 12 --body hello',
  'sudo -u root gh issue comment 4 --body hello',
  '/usr/bin/gh pr comment 12 --body hello',
  'GH_TOKEN=fixture gh pr comment 12 --body hello',
  'env GH_TOKEN=fixture gh pr comment 12 --body hello',
  'command gh pr comment 12 --body hello',
  'nice -n 5 gh issue comment 4 --body hello',
  'bash -lc "gh issue comment 4 --body hello"',
  "zsh -c 'gh pr comment 12 --body hello'",
  "eval 'gh pr comment 12 --body hello'",
  'echo $(gh pr comment 12 --body hello)',
  'gh pr view 12 && gh pr comment 12 --body hello',
  'python3 -c \'import os; os.system("gh pr comment 12 --body hello")\''
]

test('default auto-run refuses gh comment posts before execCapture, including wrappers and an open allowlist', async () => {
  assert.equal(bot.tools.includes('github_comment_draft'), false)
  assert.equal(bot.tools.includes('shell'), true)
  for (const command of comments) {
    for (const settings of [autoSettings(), autoSettings({ allowlist: opened })]) {
      const seen = state()
      const { result, prompts } = await runShell(command, settings)
      assert.equal(seen.execs.length, 0, command)
      assert.equal(prompts.length, 0, command)
      assert.equal(result.ok, false, command)
      assert.match(result.output, /github_comment_draft/, command)
      assert.match(result.output, /never executed/, command)
      assert.equal(result.output.includes('must-not-run'), false, command)
    }
  }
})

test('default auto-run does not auto-approve gh comment posts on the CLI callback', async () => {
  for (const command of comments) {
    for (const settings of [autoSettings(), autoSettings({ allowlist: opened })]) {
      const seen = state()
      const decision = await cli(command, settings)
      assert.equal(decision, 'reject', command)
      assert.equal(seen.cliApprovals.length, 0, command)
    }
  }
  const buried = state()
  const request = chat(autoSettings({ allowlist: ['*'] }))
  const decision = await request.approve({
    kind: 'shell',
    summary: 'Codex wants to run: gh pr comment 12 --body hello',
    detail: 'permission pattern only',
    target: '*'
  })
  assert.equal(decision, 'reject')
  assert.equal(buried.cliApprovals.length, 0)
})

test('other gh writes always confirm and gh reads still auto-run', async () => {
  const writes = [
    'gh pr create --title t --body b',
    'gh pr merge 12',
    'gh pr review 12 --approve',
    'gh pr review 12 --comment --body hello',
    'gh pr close 12',
    'gh pr edit 12 --title renamed',
    'gh issue create --title t --body b',
    'gh issue close 4',
    'gh issue edit 4 --title renamed',
    'gh api --method POST repos/octocat/hello/issues -f title=t -f body=b',
    'gh api -X PATCH repos/octocat/hello/issues/1 -f title=renamed',
    'nice -n 5 gh pr merge 12'
  ]
  for (const command of writes) {
    for (const settings of [autoSettings(), autoSettings({ allowlist: opened })]) {
      const seen = state()
      const { result, prompts } = await runShell(command, settings)
      assert.equal(seen.execs.length, 0, command)
      assert.equal(prompts.length, 1, command)
      assert.equal(prompts[0].force, true, command)
      assert.match(result.output, /declined/, command)
      assert.equal(result.output.includes('github_comment_draft'), false, command)
      const decision = await cli(command, settings)
      assert.equal(decision, 'reject', command)
      assert.equal(seen.cliApprovals.length, 1, command)
      assert.equal(seen.cliApprovals[0].force, true, command)
      assert.equal(api.evaluate(settings, 'shell', command, new Set(), false).outcome, 'allow', command)
      assert.equal(api.evaluate(settings, 'shell', command, new Set(), true).outcome, 'ask', command)
    }
  }

  for (const command of ['gh pr view 12', 'gh issue list', 'gh api repos/octocat/hello/issues/1/comments', 'gh api --method GET repos/octocat/hello/issues/1/comments', 'gh status']) {
    const seen = state()
    const { result, prompts } = await runShell(command)
    assert.equal(prompts.length, 0, command)
    assert.equal(seen.execs.length, 1, command)
    assert.equal(result.ok, true, result.output)
    const decision = await cli(command)
    assert.equal(decision, 'approve-always', command)
    assert.equal(seen.cliApprovals.at(-1).force, false)
  }
})

test('mentioning a comment command does not refuse it, and destructive refuses still win', async () => {
  const seen = state()
  const mentioned = await runShell('echo "gh pr comment 12 --body hello"')
  assert.equal(mentioned.prompts.length, 0)
  assert.equal(seen.execs.length, 1)
  assert.equal(mentioned.result.output.includes('github_comment_draft'), false)
  const printed = await runShell('python3 -c \'print("gh pr comment 12 --body hello")\'')
  assert.equal(printed.prompts.length, 1)
  assert.equal(printed.prompts[0].force, true)
  assert.equal(printed.result.output.includes('github_comment_draft'), false)
  const destroyed = await runShell('rm -rf /')
  assert.equal(seen.execs.length, 1, 'only the echo reached exec')
  assert.match(destroyed.result.output, /never executed/)
  assert.equal(destroyed.result.output.includes('github_comment_draft'), false)
  const analysis = api.analyzeCommand('git status')
  assert.equal(analysis.risk, 'safe')
  assert.equal(analysis.blocked, undefined)
})
