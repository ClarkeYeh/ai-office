import type { FastifyInstance } from 'fastify';
import { SubmissionHeadersSchema } from '@ai-office/contracts/agent-submission';
import type { HandleSubmission } from '../application/submissions/handle-submission.js';

export interface AgentGatewayDependencies {
  submissions: Pick<HandleSubmission, 'handle'>;
  /** Actual listening port, including when composition selects an ephemeral port. */
  port: number | (() => number);
}

/**
 * Register separately from cookie-authenticated API routes. Composition must deliver
 * scheduler callbacks to HandleSubmission.onTimer first, forwarding only unclaimed
 * timers to runners.onTimer. This releases merge waits after 120 seconds (HTTP 202);
 * retries must use the same HandleSubmission instance and unchanged submission body.
 */
export function registerAgentGateway(
  app: FastifyInstance,
  deps: AgentGatewayDependencies,
): void {
  app.register(
    async (gateway) => {
      gateway.addHook('onRequest', async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const port = typeof deps.port === 'function' ? deps.port() : deps.port;
        // Use the raw Host, never forwarded headers or proxy-derived hostname.
        if (
          Object.hasOwn(request.headers, 'origin') ||
          ![`127.0.0.1:${port}`, `localhost:${port}`].includes(
            request.headers.host ?? '',
          )
        ) {
          return reply.code(403).send({ error: 'forbidden' });
        }
      });
      gateway.setNotFoundHandler((_request, reply) => {
        return reply.code(404).send({ error: 'not_found' });
      });
      // Fastify parser errors can include submitted text. Never echo or log them.
      gateway.setErrorHandler((error, _request, reply) => {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 413)
          return reply.code(413).send({ error: 'payload_too_large' });
        if (status === 400 || status === 415)
          return reply.code(400).send({ error: 'invalid_body' });
        return reply.code(500).send({ error: 'submission_unavailable' });
      });
      gateway.post('/submissions', async (request, reply) => {
        const headers = SubmissionHeadersSchema.safeParse(request.headers);
        // Leave invalid identity handling to the use case so rejection is recorded.
        const result = await deps.submissions.handle(
          headers.success ? headers.data : request.headers,
          request.body,
        );
        return reply.code(result.status).send(result.body);
      });
    },
    { prefix: '/agent/v1', logLevel: 'silent' },
  );
}
