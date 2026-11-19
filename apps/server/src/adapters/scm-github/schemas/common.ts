import { z } from 'zod';
/** Unknown additive fields are accepted; fields consumed by methods remain required. */
export const viewerSchema = z.looseObject({ login: z.string() });
export const rateLimitSchema = z.looseObject({
  resources: z.looseObject({
    core: z.looseObject({
      remaining: z.number().int().nonnegative(),
      reset: z.number().int().nonnegative(),
    }),
  }),
});
export const emptySchema = z.unknown();
