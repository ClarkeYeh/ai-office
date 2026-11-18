import { fastifyCookie as cookie } from '@fastify/cookie';
import type { preHandlerHookHandler, FastifyRequest } from 'fastify';
import type { SessionService } from '../../application/auth/session.js';
import { ApiError } from '../errors.js';

export interface AuthDependencies {
  sessions: Pick<SessionService, 'exchangeBootstrapCode' | 'verify'>;
  port: number;
  /** Accepted only when dev is explicitly true. */
  dev?: boolean;
  devOrigin?: string;
}

export function checkHost(
  request: FastifyRequest,
  deps: AuthDependencies,
): void {
  // Use the raw Host, never forwarded headers or Fastify's proxy-derived hostname.
  if (
    ![`127.0.0.1:${deps.port}`, `localhost:${deps.port}`].includes(
      request.headers.host ?? '',
    )
  )
    throw new ApiError('forbidden_host');
}

export function checkOrigin(
  request: FastifyRequest,
  deps: AuthDependencies,
): void {
  const origin = request.headers.origin;
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  const allowed = [
    `http://127.0.0.1:${deps.port}`,
    `http://localhost:${deps.port}`,
  ];
  if (deps.dev === true && deps.devOrigin) allowed.push(deps.devOrigin);
  if (
    (mutating && origin === undefined) ||
    (origin !== undefined && !allowed.includes(origin))
  )
    throw new ApiError('forbidden_origin');
}

/** Also injected into registerStream, whose hijacked response must never bypass auth. */
export function requireSession(deps: AuthDependencies): preHandlerHookHandler {
  return async (request) => {
    checkHost(request, deps);
    checkOrigin(request, deps);
    const session = cookie.parse(request.headers.cookie ?? '').aio_session;
    if (!session || !deps.sessions.verify(session))
      throw new ApiError('unauthorized');
  };
}
