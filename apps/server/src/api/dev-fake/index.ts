import cookiePlugin from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { requireSession, type AuthDependencies } from '../auth/index.js';
import { ApiError, mapError } from '../errors.js';

/** Plain functions supplied by main.ts; this module never imports adapters. */
export interface DevFakeControls {
  editIssueBody?(number: number, body: string): Promise<void>;
  setPrStatus?(
    number: number,
    status: {
      mergeable?: boolean | null;
      checks?: 'none' | 'pending' | 'success' | 'failure';
    },
  ): void;
  setRuntimeConnected?(connected: boolean): void;
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
    if (controls.editIssueBody)
      scope.post(
        '/dev/fake/scm/edit-issue-body',
        { onRequest: requireSession(auth) },
        async (request) => {
          const body = request.body as {
            number?: unknown;
            body?: unknown;
          } | null;
          if (
            !body ||
            !validNumber(body.number) ||
            typeof body.body !== 'string'
          )
            throw new ApiError('validation_failed');
          await controls.editIssueBody!(body.number, body.body);
          return { ok: true };
        },
      );
    if (controls.setPrStatus)
      scope.post(
        '/dev/fake/scm/pr-status',
        { onRequest: requireSession(auth) },
        async (request) => {
          const body = request.body as {
            number?: unknown;
            mergeable?: unknown;
            checks?: unknown;
          } | null;
          if (
            !body ||
            !validNumber(body.number) ||
            (body.mergeable === undefined && body.checks === undefined) ||
            (body.mergeable !== undefined &&
              body.mergeable !== null &&
              typeof body.mergeable !== 'boolean') ||
            (body.checks !== undefined &&
              (typeof body.checks !== 'string' ||
                !['none', 'pending', 'success', 'failure'].includes(
                  body.checks,
                )))
          )
            throw new ApiError('validation_failed');
          controls.setPrStatus!(body.number, {
            ...(body.mergeable === undefined
              ? {}
              : { mergeable: body.mergeable as boolean | null }),
            ...(body.checks === undefined
              ? {}
              : {
                  checks: body.checks as
                    'none' | 'pending' | 'success' | 'failure',
                }),
          });
          return { ok: true };
        },
      );
    if (controls.setRuntimeConnected)
      scope.post(
        '/dev/fake/runtime/connected',
        { onRequest: requireSession(auth) },
        async (request) => {
          const body = request.body as { connected?: unknown } | null;
          if (!body || typeof body.connected !== 'boolean')
            throw new ApiError('validation_failed');
          controls.setRuntimeConnected!(body.connected);
          return { ok: true };
        },
      );
  });
}
const validNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
