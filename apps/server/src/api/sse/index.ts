import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import {
  StreamHeadersSchema,
  StreamQuerySchema,
} from '@ai-office/contracts/stream';
import type { StreamService } from '../../application/stream/index.js';

export type StreamDependencies = { stream: Pick<StreamService, 'open'> };

/** Register inside the authenticated API scope; composition supplies its auth hook. */
export function registerStream(
  app: FastifyInstance,
  deps: StreamDependencies,
  options: { preHandler: preHandlerHookHandler },
): void {
  const connections = new Set<() => void>();
  app.addHook('preClose', async () => {
    for (const close of connections) close();
  });
  app.get(
    '/api/v1/stream',
    { preHandler: options.preHandler },
    async (request, reply) => {
      const rawQuery = request.query as Record<string, unknown>;
      const cursor = rawQuery.afterSeq;
      const query = StreamQuerySchema.safeParse({
        ...rawQuery,
        ...(cursor === undefined
          ? {}
          : {
              afterSeq:
                typeof cursor === 'string' && /^\d+$/.test(cursor)
                  ? Number(cursor)
                  : NaN,
            }),
      });
      const headers = StreamHeadersSchema.safeParse(request.headers);
      const afterSeq =
        headers.success && headers.data['last-event-id'] !== undefined
          ? Number(headers.data['last-event-id'])
          : query.success
            ? (query.data.afterSeq ?? 0)
            : NaN;
      if (
        !query.success ||
        !headers.success ||
        !Number.isSafeInteger(afterSeq)
      ) {
        return reply.code(400).send({
          error: {
            code: 'validation_failed',
            category: 'validation',
            message: 'Invalid stream query or Last-Event-ID',
            retryable: false,
            details: {},
          },
        });
      }
      // Opening can fail before the HTTP response is committed.
      const stream = deps.stream.open({
        afterSeq,
        ...(query.data.workflowId === undefined
          ? {}
          : { workflowId: query.data.workflowId }),
      });
      const response = reply.raw;
      let closed = false;
      let blocked = false;
      let releaseDrain: (() => void) | undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        connections.delete(close);
        response.off('drain', drained);
        response.off('close', close);
        response.off('error', close);
        releaseDrain?.();
        void stream.return();
        response.end();
      };
      const drained = () => {
        blocked = false;
        releaseDrain?.();
        releaseDrain = undefined;
      };
      const keepalive = setInterval(() => {
        if (!closed && !blocked) blocked = !response.write(':keepalive\n\n');
      }, 15_000);
      keepalive.unref();
      connections.add(close);
      response.on('drain', drained);
      response.once('close', close);
      response.once('error', close);
      reply.hijack();
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) response.setHeader(name, value);
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      response.flushHeaders();
      try {
        while (!closed) {
          if (blocked)
            await new Promise<void>((resolve) => {
              releaseDrain = resolve;
            });
          if (closed) break;
          const result = await stream.next();
          if (result.done || closed) break;
          // A keepalive may have filled the socket while next() was pending.
          if (blocked)
            await new Promise<void>((resolve) => {
              releaseDrain = resolve;
            });
          if (closed) break;
          const frame = result.value;
          blocked = !response.write(
            `event: ${frame.event}\n${frame.event === 'domain' ? `id: ${frame.id}\n` : ''}data: ${JSON.stringify(frame.data)}\n\n`,
          );
          if (frame.event === 'resync_required') break;
        }
      } finally {
        close();
      }
    },
  );
}
