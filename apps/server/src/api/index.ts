import cookiePlugin, { fastifyCookie as cookie } from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest, FastifyError } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import {
  apiEndpoints,
  ErrorResponseSchema,
  type EndpointContract,
} from '@ai-office/contracts/api';
import {
  checkHost,
  checkOrigin,
  requireSession,
  type AuthDependencies,
} from './auth/index.js';
import { apiError, mapError, ApiError } from './errors.js';
import { routeHandlers, type RouteDependencies } from './routes/index.js';
import { registerStream, type StreamDependencies } from './sse/index.js';
export { requireSession } from './auth/index.js';
export type ApiDependencies = AuthDependencies &
  RouteDependencies &
  StreamDependencies;

/** Isolated plugin scope: does not install cookie auth on the agent gateway. */
export async function registerApi(
  app: FastifyInstance,
  deps: ApiDependencies,
): Promise<void> {
  await app.register(async (scope) => {
    await scope.register(cookiePlugin);
    scope.setValidatorCompiler(validatorCompiler);
    scope.setSerializerCompiler(serializerCompiler);
    scope.setErrorHandler<FastifyError>((error, _request, reply) => {
      const mapped =
        error.validation ||
        [
          'FST_ERR_CTP_INVALID_JSON_BODY',
          'FST_ERR_CTP_EMPTY_JSON_BODY',
          'FST_ERR_CTP_INVALID_MEDIA_TYPE',
          'FST_ERR_BAD_URL',
        ].includes(error.code ?? '')
          ? apiError('validation_failed')
          : mapError(error);
      return reply
        .header('cache-control', 'no-store')
        .code(mapped.status)
        .send(mapped.body);
    });
    const auth = requireSession(deps);
    const handlers = routeHandlers(deps);
    for (const endpoint of apiEndpoints) {
      if (
        endpoint.operationId === 'submitAgent' ||
        endpoint.operationId === 'streamEvents'
      )
        continue;
      const contract: EndpointContract = endpoint;
      const bootstrap = endpoint.operationId === 'bootstrap';
      scope.route({
        method: endpoint.method === 'get' ? 'GET' : 'POST',
        ...(bootstrap ? { logLevel: 'silent' as const } : {}),
        url: endpoint.path.replace(/\{(\w+)\}/g, ':$1'),
        // Authenticate before parsing/validation, including malformed GET/POST requests.
        onRequest: bootstrap
          ? async (request, reply) => {
              reply.header('referrer-policy', 'no-referrer');
              checkHost(request, deps);
              checkOrigin(request, deps);
            }
          : auth,
        preValidation: async (request) => {
          if (endpoint.operationId !== 'listEvents') return;
          const query = request.query as Record<string, unknown>;
          for (const field of ['afterSeq', 'limit']) {
            const value = query[field];
            if (value !== undefined) {
              if (
                typeof value !== 'string' ||
                !/^\d+$/.test(value) ||
                !Number.isSafeInteger(Number(value)) ||
                (field === 'limit' && Number(value) === Number.MAX_SAFE_INTEGER)
              )
                throw new ApiError('validation_failed');
              query[field] = Number(value);
            }
          }
        },
        schema: {
          ...(contract.body ? { body: contract.body } : {}),
          ...(contract.query ? { querystring: contract.query } : {}),
          ...(contract.params ? { params: contract.params } : {}),
          // Preserve cookie/host/origin headers: Zod otherwise strips unknown headers.
          ...(contract.headers
            ? { headers: contract.headers.passthrough() }
            : {}),
          response: {
            [contract.status ?? 200]: contract.response,
            default: ErrorResponseSchema,
          },
        },
        handler: async (request: FastifyRequest, reply) => {
          reply.header('cache-control', 'no-store');
          if (endpoint.operationId === 'bootstrap') {
            const token = deps.sessions.exchangeBootstrapCode(
              (request.query as { code: string }).code,
            );
            if (token === null) throw new ApiError('bootstrap_code_invalid');
            return reply
              .header(
                'set-cookie',
                cookie.serialize('aio_session', token, {
                  httpOnly: true,
                  sameSite: 'strict',
                  path: '/',
                  maxAge: 30 * 24 * 60 * 60,
                }),
              )
              .header('referrer-policy', 'no-referrer')
              .header('location', '/')
              .code(302)
              .send(null);
          }
          return reply
            .code(contract.status ?? 200)
            .send(await handlers[endpoint.operationId](request));
        },
      });
    }
    registerStream(scope, deps, { preHandler: auth });
    scope.all('/api/*', { onRequest: auth }, async () => {
      throw new ApiError('not_found');
    });
  });
}
