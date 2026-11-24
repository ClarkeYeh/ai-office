import type { FastifyInstance } from 'fastify';
import {
  CONTROL_TOKEN_PREFIX,
  LocalBootstrapCodeResponseSchema,
} from '@ai-office/contracts/agent-submission';
import { apiError } from '../errors.js';

export interface LocalDependencies {
  readonly port: number;
  verifyControlToken(candidate: string): boolean;
  sessions: { issueBootstrapCode(): string };
  now(): Date;
  issued(): void;
}

/** Separate Fastify scope: Bearer authentication never falls through to cookies. */
export async function registerLocal(
  app: FastifyInstance,
  deps: LocalDependencies,
): Promise<void> {
  let issuedAt: number[] = [];
  await app.register(async (scope) => {
    scope.post(
      '/local/v1/bootstrap-codes',
      {
        logLevel: 'silent',
        onRequest: async (request, reply) => {
          reply.header('cache-control', 'no-store');
          const reject = (code: Parameters<typeof apiError>[0]) => {
            const error = apiError(code);
            return reply.code(error.status).send(error.body);
          };
          if (
            ![`127.0.0.1:${deps.port}`, `localhost:${deps.port}`].includes(
              request.headers.host ?? '',
            )
          )
            return reject('forbidden_host');
          if (request.headers.origin !== undefined)
            return reject('forbidden_origin');
          const match = new RegExp(
            `^Bearer (${CONTROL_TOKEN_PREFIX}[a-f0-9]{64})$`,
          ).exec(request.headers.authorization ?? '');
          if (!deps.verifyControlToken(match?.[1] ?? ''))
            return reject('control_token_invalid');
          const now = deps.now().getTime();
          issuedAt = issuedAt.filter((time) => time > now - 60_000);
          if (issuedAt.length >= 5) {
            reply.header(
              'retry-after',
              Math.ceil((issuedAt[0]! + 60_000 - now) / 1000),
            );
            return reject('bootstrap_rate_limited');
          }
          issuedAt.push(now);
        },
      },
      async (_request, reply) => {
        const expiresAt = new Date(deps.now().getTime() + 60_000).toISOString();
        const code = deps.sessions.issueBootstrapCode();
        deps.issued();
        return reply.send(
          LocalBootstrapCodeResponseSchema.parse({ code, expiresAt }),
        );
      },
    );
  });
}
