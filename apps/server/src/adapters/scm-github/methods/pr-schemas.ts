import { z } from 'zod';
import type { PrRef } from '../../../ports/refs.js';
/** Consumed fields only (M3_PLAN §1.5): GitHub may add fields at any time. */
export const pullSchema = z.looseObject({
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed']),
  merged: z.boolean().nullable().optional(),
  merged_at: z.string().nullable().optional(),
  merge_commit_sha: z.string().nullable().optional(),
  merged_by: z.looseObject({ login: z.string() }).nullable().optional(),
  html_url: z.string(),
  body: z.string().nullable().optional(),
  head: z.looseObject({ ref: z.string(), sha: z.string() }),
  base: z.looseObject({ ref: z.string() }),
});
export type Pull = z.infer<typeof pullSchema>;
/** `merged` is absent from list items; `merged_at` is present in both. */
export const isMerged = (pull: Pull) => pull.merged ?? !!pull.merged_at;
export const prParams = (ref: PrRef) => ({
  owner: ref.repo.owner,
  repo: ref.repo.name,
  number: ref.number,
});
export const marker = (commandId: string) =>
  `<!-- ai-office:cmd=${commandId} -->`;
export const anyMarker = /<!-- ai-office:cmd=[^\s<>]+ -->/;
