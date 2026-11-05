import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuthGuard, registerAuthRoutes } from './auth';
import { installErrorHandler } from './errors';
import { registerNodeRoutes } from './nodes';
import { registerPages } from './pages';
import { registerRunRoutes } from './runs';
import { SessionService } from './session';
import { ProjectStore } from './store';
import { registerTerminalRoute } from './terminal';
import { registerWorkspaceRoutes } from './workspace';

export interface CreateProjectServerOptions {
  projectRoot: string;
  credential?: string;
  webDist?: string;
  logger?: boolean;
}

export interface ListenResult {
  url: string;
  port: number;
}

export interface ProjectServer {
  app: FastifyInstance;
  store: ProjectStore;
  session: SessionService;
  generatedCredential?: string;
  listen(port?: number, host?: string): Promise<ListenResult>;
  close(): Promise<void>;
}

export interface RunningProjectServer extends ProjectServer, ListenResult {}

/** Resolves the Vite build from either `apps/server/src` or `apps/server/dist`. */
export function defaultWebDistPath(): string {
  return fileURLToPath(new URL('../../web/dist', import.meta.url));
}

export async function createProjectServer(
  options: CreateProjectServerOptions,
): Promise<ProjectServer> {
  const projectRoot = resolve(options.projectRoot);
  const webDist = resolve(options.webDist ?? process.env.SFLOW_WEB_DIST ?? defaultWebDistPath());

  const store = new ProjectStore(projectRoot);
  const { generatedCredential } = store.initializeCredential(options.credential);
  const session = new SessionService(store.getSessionSecret());
  const app = Fastify({ logger: options.logger ?? false });

  // Install the error and not-found handlers before routes register so every
  // route uses the Project Server error shape.
  installErrorHandler(app);

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);

  registerAuthGuard(app, session);
  registerAuthRoutes(app, store, session);
  registerNodeRoutes(app);
  registerWorkspaceRoutes(app, store);
  registerRunRoutes(app, store);
  registerTerminalRoute(app, store);
  registerPages(app, session, webDist);

  const assetsDir = join(webDist, 'assets');
  if (existsSync(join(webDist, 'index.html')) && existsSync(assetsDir)) {
    await app.register(fastifyStatic, {
      root: assetsDir,
      prefix: '/assets/',
      index: false,
    });
  }

  app.addHook('onClose', async () => {
    store.close();
  });

  return {
    app,
    store,
    session,
    generatedCredential,
    async listen(port = 4173, host = '127.0.0.1'): Promise<ListenResult> {
      const address = await app.listen({ port, host });
      const serverAddress = app.server.address();
      const boundPort = typeof serverAddress === 'object' && serverAddress !== null
        ? serverAddress.port
        : port;
      return { url: address, port: boundPort };
    },
    async close(): Promise<void> {
      await app.close();
    },
  };
}

export async function startProjectServer(
  options: CreateProjectServerOptions & { port?: number; host?: string },
): Promise<RunningProjectServer> {
  const server = await createProjectServer(options);
  const listenResult = await server.listen(options.port, options.host);
  return Object.assign(server, listenResult);
}
