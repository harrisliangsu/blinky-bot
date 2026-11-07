import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { hydratedEnv } from '../backends/loginShellEnv'
import { which } from '../backends/which'
import { validGitHubIssueTarget } from './githubTarget'
import { requireGitHubConnection } from './githubConnection'

/** Read-only polling. No issue content is stored locally, only its fingerprint. */
export async function githubIssueFingerprint(owner: string, repo: string, number: number): Promise<string> {
  if (!validGitHubIssueTarget(owner, repo, number)) throw new Error('Invalid GitHub issue target.')
  await requireGitHubConnection()
  const binary = await which('gh')
  if (!binary) throw new Error('GitHub CLI is unavailable.')
  const env = await hydratedEnv()
  await requireGitHubConnection()
  const data = await new Promise<string>((resolve, reject) => {
    const child = spawn(binary, ['api', '--hostname', 'github.com', `repos/${owner}/${repo}/issues/${number}`], { env, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = '', settled = false
    const done = (ok: boolean): void => { if (settled) return; settled = true; clearTimeout(timer); ok ? resolve(output) : reject(new Error('GitHub issue could not be checked.')) }
    const timer = setTimeout(() => { child.kill(); done(false) }, 15000)
    child.on('error', () => done(false))
    child.stdout.on('data', (part: Buffer) => { output += part.toString(); if (output.length > 2_000_000) { child.kill(); done(false) } })
    child.on('close', (code) => done(code === 0))
  })
  let issue: Record<string, unknown>
  try { issue = JSON.parse(data) as Record<string, unknown> } catch { throw new Error('GitHub returned an invalid issue.') }
  const expected = `https://api.github.com/repos/${owner}/${repo}/issues/${number}`.toLowerCase()
  if (!issue || issue.number !== number || typeof issue.url !== 'string' || issue.url.toLowerCase() !== expected || typeof issue.updated_at !== 'string' || !Number.isFinite(Date.parse(issue.updated_at))) throw new Error('GitHub returned a different or invalid issue.')
  const fingerprint = JSON.stringify([issue.updated_at, issue.state, issue.title, issue.body, issue.comments, issue.labels, issue.assignees, issue.milestone])
  return createHash('sha256').update(fingerprint).digest('hex')
}
