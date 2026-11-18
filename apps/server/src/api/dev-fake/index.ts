import cookiePlugin from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { requireSession, type AuthDependencies } from '../auth/index.js';
import { ApiError, mapError } from '../errors.js';

/** Plain functions supplied by main.ts; this module never imports adapters. */
export interface DevFakeControls {
  mergeOwner(number: number): Promise<{ mergeCommitSha: string }>;
}

/** Registered by the composition root only for --dev --fake; not OpenAPI. */
export async function registerDevFakeRoutes(
  app: FastifyInstance,
  auth: AuthDependencies,
  controls: DevFakeControls,
): Promise<void> {
  await app.register(async (scope) => {
    await scope.register(cookiePlugin);
    scope.setErrorHandler((error, _request, reply) => {
      const mapped = mapError(error);
      return reply.code(mapped.status).send(mapped.body);
    });
    scope.post(
      '/dev/fake/scm/merge-final-pr',
      {
        onRequest: requireSession(auth),
      },
      async (request) => {
        const body = request.body as { number?: unknown } | null;
        if (
          !body ||
          typeof body.number !== 'number' ||
          !Number.isSafeInteger(body.number) ||
          body.number < 1
        )
          throw new ApiError('validation_failed');
        return controls.mergeOwner(body.number);
      },
    );
  });
}
