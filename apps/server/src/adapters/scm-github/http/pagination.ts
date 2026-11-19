import { guard } from '../policy/endpoints.js';

/** The pagination parameters a validated `Link: rel="next"` may change. */
export type NextPage = {
  page?: number;
  after?: string;
  before?: string;
  /** Set when GitHub used `/repositories/{id}/…`; the client checks the ID. */
  repositoryId?: number;
};
const CURSOR = /^[A-Za-z0-9+/=_-]{1,512}$/;
const MOVABLE = ['page', 'after', 'before', 'per_page'];

/**
 * Validate GitHub's next link against the exact authorized request URL. The
 * link may use the canonical `/repositories/{id}/<same suffix>` form and add an
 * opaque `after`/`before` cursor (cursor-paginated lists); nothing else may
 * differ. The caller re-issues the authorized endpoint with these parameters,
 * so credentials never go to a Link-supplied URL.
 */
export function nextPage(
  link: string | null,
  current: URL,
): NextPage | undefined {
  if (!link) return;
  const matches = [...link.matchAll(/<([^>]+)>\s*;\s*rel="([^"]+)"/g)].filter(
    (match) => match[2]!.split(' ').includes('next'),
  );
  if (!matches.length) return;
  if (matches.length !== 1) guard('invalid_pagination');
  let next: URL;
  try {
    next = new URL(matches[0]![1]!);
  } catch {
    return guard('invalid_pagination');
  }
  if (
    next.origin !== 'https://api.github.com' ||
    next.origin !== current.origin ||
    next.username ||
    next.password ||
    next.hash
  )
    guard('invalid_pagination');
  let repositoryId: number | undefined;
  if (next.pathname !== current.pathname) {
    // `/repos/{owner}/{repo}<suffix>` ↔ `/repositories/{id}<suffix>`.
    const repos = /^\/repos\/[^/]+\/[^/]+(\/.*)?$/.exec(current.pathname);
    const canonical = /^\/repositories\/([1-9]\d{0,15})(\/.*)?$/.exec(
      next.pathname,
    );
    if (!repos || !canonical || (repos[1] ?? '') !== (canonical[2] ?? ''))
      guard('invalid_pagination');
    repositoryId = Number(canonical[1]);
    if (!Number.isSafeInteger(repositoryId)) guard('invalid_pagination');
  }
  const fixed = (url: URL) => {
    const params = new URLSearchParams(url.search);
    for (const key of MOVABLE) params.delete(key);
    params.sort();
    return params.toString();
  };
  if (fixed(next) !== fixed(current)) guard('invalid_pagination');
  if (
    current.searchParams.has('per_page') &&
    next.searchParams.has('per_page') &&
    next.searchParams.get('per_page') !== current.searchParams.get('per_page')
  )
    guard('invalid_pagination');
  for (const key of MOVABLE)
    if (next.searchParams.getAll(key).length > 1) guard('invalid_pagination');
  const result: NextPage = {};
  const page = next.searchParams.get('page');
  if (page !== null) {
    if (!/^[1-9]\d{0,5}$/.test(page)) guard('invalid_pagination');
    if (Number(page) <= Number(current.searchParams.get('page') ?? 1))
      guard('pagination_repeated');
    result.page = Number(page);
  }
  for (const key of ['after', 'before'] as const) {
    const value = next.searchParams.get(key);
    if (value === null) continue;
    if (!CURSOR.test(value)) guard('invalid_pagination');
    if (value === current.searchParams.get(key)) guard('pagination_repeated');
    result[key] = value;
  }
  if (result.page === undefined && !result.after && !result.before)
    guard('invalid_pagination');
  if (repositoryId !== undefined) result.repositoryId = repositoryId;
  return result;
}

/** Query parameters for the next request of the same authorized endpoint. */
export function nextQuery(
  next: NextPage,
): Record<string, string | number | undefined> {
  return {
    page: next.page,
    after: next.after,
    before: next.before,
  };
}
