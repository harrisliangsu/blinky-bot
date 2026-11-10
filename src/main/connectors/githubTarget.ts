export function validGitHubIssueTarget(owner: string, repo: string, number: number): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) && /^[A-Za-z0-9_.-]{1,100}$/.test(repo) && repo !== '.' && repo !== '..' && Number.isSafeInteger(number) && number > 0
}
