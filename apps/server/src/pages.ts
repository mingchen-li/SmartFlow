import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { SESSION_COOKIE_NAME, type SessionService } from './session';

const FALLBACK_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SFlow</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; font-family: system-ui, sans-serif; }
      main { max-width: 34rem; padding: 2rem; text-align: center; }
      .brand { color: LinkText; font-size: 1.5rem; font-weight: 700; letter-spacing: 0.02em; }
      p { color: GrayText; line-height: 1.6; }
      code { color: CanvasText; }
    </style>
  </head>
  <body>
    <main>
      <div class="brand">SFlow</div>
      <h1>Web workspace assets are not built</h1>
      <p>Run <code>pnpm build</code> from the repository root, then reload this page.</p>
    </main>
  </body>
</html>`;

/**
 * Serves the Web shell. `/login` is public; `/` redirects unauthenticated
 * visitors to `/login`. When the Vite build is absent, a small build-required
 * page keeps the Server usable for API work.
 */
export function registerPages(
  app: FastifyInstance,
  session: SessionService,
  webDist: string,
): void {
  const indexPath = join(webDist, 'index.html');

  const sendApp = (reply: FastifyReply): FastifyReply => {
    reply.header('cache-control', 'no-store');
    if (existsSync(indexPath)) {
      return reply.type('text/html; charset=utf-8').send(readFileSync(indexPath, 'utf8'));
    }
    return reply.type('text/html; charset=utf-8').send(FALLBACK_PAGE);
  };

  app.get('/', async (request, reply) => {
    if (!session.verify(request.cookies[SESSION_COOKIE_NAME])) {
      return reply.code(302).header('location', '/login').send();
    }
    return sendApp(reply);
  });

  app.get('/login', async (request, reply) => {
    if (session.verify(request.cookies[SESSION_COOKIE_NAME])) {
      return reply.code(302).header('location', '/').send();
    }
    return sendApp(reply);
  });
}
