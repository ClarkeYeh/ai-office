import { z } from 'zod';
import { PortError } from '../../../ports/errors.js';
import type { RequestOptions, RequestParams } from '../http/types.js';
import type { RepoAllowlist } from './repos.js';
const root = '/repos/{owner}/{repo}';
const text = z.string();
const strings = z.array(text);
const patch = z.strictObject({
  title: text.optional(),
  body: text.optional(),
  state: z.enum(['open', 'closed']).optional(),
});
const endpoint = (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: z.ZodType,
  content = false,
  uncertain = false,
) => ({ method, path, body, content, uncertain });
/** This table is the sole transport entry point. There is no arbitrary URL API. */
export const endpoints = {
  'user.get': endpoint('GET', '/user'),
  'rateLimit.get': endpoint('GET', '/rate_limit'),
  'repos.get': endpoint('GET', root),
  'branches.get': endpoint('GET', `${root}/branches/{branch}`),
  'branches.protection': endpoint(
    'GET',
    `${root}/branches/{branch}/protection`,
  ),
  'branches.rules': endpoint('GET', `${root}/rules/branches/{branch}`),
  'labels.list': endpoint('GET', `${root}/labels`),
  'labels.create': endpoint(
    'POST',
    `${root}/labels`,
    z.strictObject({ name: text, color: text, description: text.optional() }),
  ),
  'refs.get': endpoint('GET', `${root}/git/ref/heads/{ref}`),
  'refs.list': endpoint('GET', `${root}/git/matching-refs/heads/ai-office/`),
  'refs.create': endpoint(
    'POST',
    `${root}/git/refs`,
    z.strictObject({
      ref: text.startsWith('refs/heads/ai-office/'),
      sha: text.regex(/^[a-f0-9]{40}$/i),
    }),
  ),
  'refs.delete': endpoint('DELETE', `${root}/git/refs/heads/{ref}`),
  'branches.compare': endpoint('GET', `${root}/compare/{base}...{head}`),
  'issues.list': endpoint('GET', `${root}/issues`),
  'issues.get': endpoint('GET', `${root}/issues/{number}`),
  'issues.create': endpoint(
    'POST',
    `${root}/issues`,
    z.strictObject({ title: text, body: text, labels: strings.optional() }),
    true,
    true,
  ),
  'issues.update': endpoint('PATCH', `${root}/issues/{number}`, patch),
  'issues.labels': endpoint(
    'PUT',
    `${root}/issues/{number}/labels`,
    z.strictObject({ labels: strings }),
  ),
  'comments.list': endpoint('GET', `${root}/issues/comments`),
  'comments.forIssue': endpoint('GET', `${root}/issues/{number}/comments`),
  'comments.get': endpoint('GET', `${root}/issues/comments/{id}`),
  'comments.create': endpoint(
    'POST',
    `${root}/issues/{number}/comments`,
    z.strictObject({ body: text }),
    true,
    true,
  ),
  'comments.delete': endpoint('DELETE', `${root}/issues/comments/{id}`),
  'pulls.list': endpoint('GET', `${root}/pulls`),
  'pulls.get': endpoint('GET', `${root}/pulls/{number}`),
  'pulls.create': endpoint(
    'POST',
    `${root}/pulls`,
    z.strictObject({
      title: text,
      body: text,
      base: text,
      head: text,
      draft: z.boolean().optional(),
    }),
    true,
  ),
  'pulls.update': endpoint('PATCH', `${root}/pulls/{number}`, patch),
  'pulls.merge': endpoint(
    'PUT',
    `${root}/pulls/{number}/merge`,
    z.strictObject({
      merge_method: z.literal('merge'),
      sha: text.regex(/^[a-f0-9]{40}$/i),
    }),
  ),
  'pulls.comments': endpoint('GET', `${root}/pulls/{number}/comments`),
  'pulls.reviews': endpoint('GET', `${root}/pulls/{number}/reviews`),
  'commits.checkRuns': endpoint('GET', `${root}/commits/{sha}/check-runs`),
  'commits.status': endpoint('GET', `${root}/commits/{sha}/status`),
} as const;
export type EndpointId = keyof typeof endpoints;
export function guard(code: string): never {
  throw new PortError('guard', code, code);
}
export function prepareRequest(
  id: EndpointId,
  params: RequestParams,
  options: Pick<RequestOptions<unknown>, 'safety'>,
  repos: RepoAllowlist,
) {
  if (!Object.hasOwn(endpoints, id)) guard('endpoint_not_allowed');
  const spec = endpoints[id];
  const write = spec.method !== 'GET';
  const path = spec.path.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key as keyof RequestParams];
    if (typeof value !== 'string' && typeof value !== 'number')
      guard('invalid_path_parameter');
    const string = String(value);
    if (
      !string ||
      string.split('/').some((part) => part === '.' || part === '..') ||
      /[\\%?#\u0000-\u001f]/.test(string)
    )
      guard('invalid_path_parameter');
    if (
      (key === 'owner' || key === 'repo') &&
      !/^[a-zA-Z0-9_.-]+$/.test(string)
    )
      guard('invalid_path_parameter');
    if ((key === 'number' || key === 'id') && !/^[1-9]\d*$/.test(string))
      guard('invalid_path_parameter');
    return encodeURIComponent(string);
  });
  if (spec.path.startsWith(root))
    repos.assert({ owner: params.owner!, name: params.repo! }, write);
  const safety = options.safety;
  if (
    id === 'refs.delete' &&
    (!params.ref?.startsWith('ai-office/') ||
      !safety?.defaultBranch ||
      params.ref === safety.defaultBranch ||
      safety.protected !== false)
  )
    guard('branch_delete_not_allowed');
  if (
    id === 'comments.delete' &&
    (!safety?.viewer ||
      safety.author !== safety.viewer ||
      !safety.commandId ||
      !safety.body?.includes(`<!-- ai-office:cmd=${safety.commandId} -->`))
  )
    guard('comment_delete_not_allowed');
  if (
    id === 'pulls.merge' &&
    (!safety?.defaultBranch ||
      !safety.actualBase?.startsWith('ai-office/') ||
      safety.actualBase === safety.defaultBranch)
  )
    guard('merge_base_not_allowed');
  if (
    id === 'pulls.update' &&
    typeof params.body === 'object' &&
    params.body !== null &&
    'state' in params.body &&
    params.body.state === 'closed' &&
    !/<!-- ai-office:cmd=[^\s<>]+ -->/.test(safety?.body ?? '')
  )
    guard('pr_close_not_allowed');
  if (
    spec.body
      ? !spec.body.safeParse(params.body).success
      : params.body !== undefined
  )
    guard('invalid_request_body');
  const url = new URL(path, 'https://api.github.com');
  for (const [key, value] of Object.entries(params.query ?? {}).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  if (
    params.query?.per_page !== undefined &&
    ![50, 100].includes(Number(params.query.per_page))
  )
    guard('invalid_page_size');
  return { spec, url, write };
}
