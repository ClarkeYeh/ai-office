import { z } from 'zod';
/** Only consumed fields are required; additive GitHub fields are accepted (§1.5). */
const login = z.looseObject({ login: z.string() }).nullable();
const time = z.string().min(1);
export const issueListSchema = z.array(
  z.looseObject({
    number: z.number().int().positive(),
    user: login,
    body: z.string().nullable().optional(),
    labels: z.array(z.union([z.string(), z.looseObject({ name: z.string() })])),
    created_at: time,
    updated_at: time,
    pull_request: z.unknown().optional(),
  }),
);
export const commentListSchema = z.array(
  z.looseObject({
    id: z.number().int().positive(),
    user: login,
    body: z.string().nullable().optional(),
    issue_url: z.string(),
    created_at: time,
    updated_at: time,
  }),
);
const pull = {
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed']),
  head: z.looseObject({ ref: z.string(), sha: z.string() }),
  base: z.looseObject({ ref: z.string() }),
  merged_at: z.string().nullable().optional(),
  merge_commit_sha: z.string().nullable().optional(),
  updated_at: time,
};
export const pullListSchema = z.array(z.looseObject(pull));
export const pullSchema = z.looseObject({
  ...pull,
  mergeable: z.boolean().nullable().optional(),
  merged: z.boolean().optional(),
  merged_by: login.optional(),
});
const ref = z.looseObject({
  ref: z.string(),
  object: z.looseObject({ sha: z.string() }),
});
export const refListSchema = z.array(ref);
export const refSchema = ref;
export const checkRunsSchema = z.looseObject({
  total_count: z.number().int().nonnegative(),
  check_runs: z.array(
    z.looseObject({
      status: z.string(),
      conclusion: z.string().nullable().optional(),
    }),
  ),
});
export const combinedStatusSchema = z.looseObject({
  state: z.string(),
  statuses: z.array(z.looseObject({ state: z.string() })),
});
