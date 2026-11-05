import type { FastifyInstance, FastifyRequest } from 'fastify';
import { LoginRequestSchema, RotateCredentialRequestSchema } from '@sflow/domain';
import { HttpError, errorResponse, parseOrThrow } from './errors';
import { SESSION_COOKIE_NAME, SESSION_TTL_MS, type SessionService } from './session';
import type { ProjectStore } from './store';

const PUBLIC_API_PATHS = new Set(['/api/health', '/api/auth/login']);

export function requestIsAuthenticated(request: FastifyRequest, session: SessionService): boolean {
  return session.verify(request.cookies[SESSION_COOKIE_NAME]);
}

/**
 * Every `/api/*` route is private except health and login. Websocket upgrades
 * pass through the same onRequest lifecycle, so `/api/terminal` is covered.
 */
export function registerAuthGuard(app: FastifyInstance, session: SessionService): void {
  app.addHook('onRequest', async (request, reply) => {
    const pathname = new URL(request.url, 'http://sflow.local').pathname;
    const isApiRoute = pathname === '/api' || pathname.startsWith('/api/');
    if (!isApiRoute || PUBLIC_API_PATHS.has(pathname)) return;

    if (!requestIsAuthenticated(request, session)) {
      await reply.code(401).send(errorResponse('UNAUTHENTICATED', 'Authentication required.'));
    }
  });
}

export function registerAuthRoutes(
  app: FastifyInstance,
  store: ProjectStore,
  session: SessionService,
): void {
  app.get('/api/health', async () => ({ status: 'ok' as const, name: 'SFlow' as const }));

  app.post('/api/auth/login', async (request, reply) => {
    const { credential } = parseOrThrow(LoginRequestSchema, request.body);

    if (!store.verifyCredential(credential)) {
      throw new HttpError(401, 'INVALID_CREDENTIAL', 'Invalid Project credential.');
    }

    reply.setCookie(SESSION_COOKIE_NAME, session.issue(), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });

    return reply.send({ authenticated: true, project: store.getProject() });
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return reply.send({ authenticated: false });
  });

  app.get('/api/auth/session', async () => ({
    authenticated: true as const,
    project: store.getProject(),
  }));

  app.post('/api/auth/rotate', async (request) => {
    const { currentCredential, newCredential } = parseOrThrow(
      RotateCredentialRequestSchema,
      request.body,
    );

    if (!store.verifyCredential(currentCredential)) {
      throw new HttpError(401, 'INVALID_CREDENTIAL', 'Current Project credential is incorrect.');
    }

    store.setCredential(newCredential);
    return { rotated: true as const };
  });
}
