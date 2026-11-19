import { randomBytes } from 'node:crypto';

export const REPO = 'ClarkeYeh/ai-office-spike';
export const API = 'https://api.github.com';
export const ROOT = `/repos/${REPO}`;
export const LABEL = 'ai-office-test';
export const newRunId = () => randomBytes(6).toString('hex');
export function assertRunId(id: string): void {
  if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid test run identity');
}
export function namespace(id: string): string {
  assertRunId(id);
  return `ai-office/t${id}`;
}
export function assertBranch(
  branch: string,
  runId: string,
  claims: string[] = [],
): void {
  const prefixes = [namespace(runId), ...claims.map((id) => `ai-office/${id}`)];
  if (
    !prefixes.some(
      (p) => branch.startsWith(p + '-') || branch.startsWith(p + '/'),
    ) ||
    !/^[a-zA-Z0-9/_-]+$/.test(branch) ||
    branch.includes('//')
  )
    throw new Error('Branch outside claimed namespace');
}
export function marker(commandId: string): string {
  if (!/^[a-zA-Z0-9:_/-]+$/.test(commandId))
    throw new Error('Invalid command identity');
  return `<!-- ai-office:cmd=${commandId} -->`;
}
export function assertCommand(
  commandId: string,
  runId: string,
  claims: string[] = [],
): void {
  if (
    ![`t${runId}`, ...claims].some(
      (p) => commandId.startsWith(p + ':') || commandId.startsWith(p + '-'),
    )
  )
    throw new Error('Command outside claimed namespace');
  marker(commandId);
}
export function assertRepo(repo: string): void {
  if (repo !== REPO) throw new Error('Only the spike repository is allowed');
}
export function assertRemote(url: string): void {
  if (
    ![
      `https://github.com/${REPO}.git`,
      `https://github.com/${REPO}`,
      `git@github.com:${REPO}.git`,
      `ssh://git@github.com/${REPO}.git`,
    ].includes(url)
  )
    throw new Error('Git remote is not the spike repository');
}
export function assertOptIn(env: NodeJS.ProcessEnv): void {
  if (env.CI !== undefined || env.AIO_REAL_GITHUB !== '1')
    throw new Error('Requires AIO_REAL_GITHUB=1 and CI unset');
}
