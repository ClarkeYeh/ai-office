import type { RepoCandidatesResponse } from '@ai-office/contracts/api';

export type LocalCandidate = RepoCandidatesResponse['local'][number];
export type RemoteCandidate = RepoCandidatesResponse['remote'][number];

/** The last two path segments, e.g. `…/workspace/app`; short paths stay whole. */
export function shortPath(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments.length <= 2 ? path : `…/${segments.slice(-2).join('/')}`;
}

/**
 * The copyable hint for a GitHub repo that is not in Orca. Shown only, never
 * run: clone into `~/<name>`, then add that folder to Orca.
 */
export function cloneCommands(repo: { owner: string; name: string }): string {
  const dir = `~/${repo.name}`;
  return [
    `git clone https://github.com/${repo.owner}/${repo.name} ${dir}`,
    `orca repo add --path ${dir}`,
  ].join('\n');
}

/** The viewer's login: `/user/repos?affiliation=owner` only lists their own repos. */
export function viewerLogin(remote: readonly RemoteCandidate[]): string | null {
  return remote[0]?.owner ?? null;
}

/** DOM id of a local row, the target of the GitHub row's link. */
export const localRowId = (index: number) => `local-candidate-${index}`;

/** Index of the local row a GitHub repo maps to, or -1. */
export function localIndex(
  local: readonly LocalCandidate[],
  remote: RemoteCandidate,
): number {
  return remote.local
    ? local.findIndex((repo) => repo.path === remote.local!.path)
    : -1;
}
