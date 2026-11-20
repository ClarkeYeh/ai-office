import { z } from 'zod';
import type { PrRef } from '../../../ports/refs.js';
import type { ReviewComment } from '../../../ports/scm.js';
import type { GithubHttp } from '../http/types.js';
import { prParams } from './pr-schemas.js';

const user = z.looseObject({ login: z.string() }).nullable();
const commentSchema = z.looseObject({
  id: z.number().int(),
  user,
  body: z.string(),
  path: z.string(),
  line: z.number().int().nullable().optional(),
  original_line: z.number().int().nullable().optional(),
  created_at: z.string(),
});
const reviewSchema = z.looseObject({
  id: z.number().int(),
  user,
  body: z.string().nullable(),
  submitted_at: z.string().nullable().optional(),
});

/** Every author is returned: the engine keeps only ownerLogin's (S10). */
export async function listReviewComments(
  http: GithubHttp,
  ref: PrRef,
): Promise<ReviewComment[]> {
  const [comments, reviews] = await Promise.all([
    http.paginate('pulls.comments', prParams(ref), {
      schema: z.array(commentSchema),
    }),
    http.paginate('pulls.reviews', prParams(ref), {
      schema: z.array(reviewSchema),
    }),
  ]);
  return [
    ...comments.map((c) => ({
      id: String(c.id),
      author: c.user?.login ?? '',
      body: c.body,
      path: c.path,
      line: c.line ?? c.original_line ?? null,
      occurredAt: c.created_at,
    })),
    // Pending reviews have no submitted_at; bodiless reviews carry no feedback.
    ...reviews.flatMap((r) =>
      r.body && r.submitted_at
        ? [
            {
              id: `review-${r.id}`,
              author: r.user?.login ?? '',
              body: r.body,
              path: '',
              line: null,
              occurredAt: r.submitted_at,
            },
          ]
        : [],
    ),
  ].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}
