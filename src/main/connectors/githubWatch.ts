import { createHash } from 'node:crypto'
import { readGitHubIssue } from './githubOAuth'

/** Read-only polling. No issue content is stored locally, only its fingerprint. */
export async function githubIssueFingerprint(owner: string, repo: string, number: number): Promise<string> {
  const issue = await readGitHubIssue(owner, repo, number)
  const fingerprint = JSON.stringify([issue.updated_at, issue.state, issue.title, issue.body, issue.comments, issue.labels, issue.assignees, issue.milestone])
  return createHash('sha256').update(fingerprint).digest('hex')
}
