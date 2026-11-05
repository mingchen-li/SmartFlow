import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { NodeImplementation, NodeRegistry } from '@sflow/domain';
import { createBuiltinNodeRegistry } from '@sflow/nodes';
import { LocalExecutor, Orchestrator } from '@sflow/orchestrator';
import { registerAuthGuard, registerAuthRoutes } from './auth';
import { registerAgentPatchRoutes } from './agent-patches';
import { installErrorHandler } from './errors';
import { registerNodeRoutes } from './nodes';
import { registerPages } from './pages';
import { registerRunRoutes } from './runs';
import { SessionService } from './session';
import { ProjectStore } from './store';
import { registerTerminalRoute } from './terminal';
import { registerWidgetRoutes } from './widgets';
import { registerWorkspaceRoutes } from './workspace';

export interface CreateProjectServerOptions {
  projectRoot: string;
  credential?: string;
  webDist?: string;
  logger?: boolean;
  /**
   * Deterministic pause before each local Node execution. Integration tests
   * use it to restart the Server during an active Run; production leaves it 0.
   * `SFLOW_EXECUTOR_DELAY_MS` supplies the same value to a spawned Server.
   */
  executorDelayMs?: number;
  /**
   * Installed Node registry. Defaults to the built-in deterministic Binder
   * Nodes; tests and deployments can replace implementations or add Manifest
   * versions without changing any Workflow, Run, or Result View contract.
   */
  registry?: NodeRegistry;
  /**
   * Replaces the implementation of one or more Manifests by `id@version` in
   * the installed registry. External tests inject deterministic failures this
   * way; the Manifest catalog and Run snapshots still use the declared Node
   * contracts.
   */
  nodeImplementations?: readonly NodeImplementation[];
  /**
   * Replaces the retry backoff wait. External tests use it to avoid real
   * delays; production keeps the Manifest-declared timing.
   */
  retryWait?: (milliseconds: number, signal: AbortSignal) => Promise<boolean>;
}

function registryKey(manifest: { id: string; version: string }): string {
  return `${manifest.id}@${manifest.version}`;
}

/** Installed registry with optional per-Manifest test overrides. */
function withNodeImplementations(
  base: NodeRegistry,
  overrides: readonly NodeImplementation[] = [],
): NodeRegistry {
  if (overrides.length === 0) return base;

  const overridesByKey = new Map(
    overrides.map((implementation) => [
      registryKey(implementation.manifest),
      implementation,
    ]),
  );
  return {
    get: (manifestId, manifestVersion) =>
      overridesByKey.get(`${manifestId}@${manifestVersion}`) ??
      base.get(manifestId, manifestVersion),
    list: () => {
      // Replacing a Manifest keeps its catalog position; new Manifests append.
      const merged = new Map<string, NodeImplementation>();
      for (const implementation of base.list()) {
        merged.set(registryKey(implementation.manifest), implementation);
      }
      for (const implementation of overrides) {
        merged.set(registryKey(implementation.manifest), implementation);
      }
      return [...merged.values()];
    },
  };
}

function executorDelayFromEnvironment(): number {
  const raw = process.env.SFLOW_EXECUTOR_DELAY_MS;
  if (!raw) return 0;
  const milliseconds = Number(raw);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0;
}

export interface ListenResult {
  url: string;
  port: number;
}

export interface ProjectServer {
  app: FastifyInstance;
  store: ProjectStore;
  session: SessionService;
  orchestrator: Orchestrator;
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
  const registry = withNodeImplementations(
    options.registry ?? createBuiltinNodeRegistry(),
    options.nodeImplementations,
  );
  const manifests = registry.list().map((implementation) => implementation.manifest);
  const executor = new LocalExecutor({
    projectRoot,
    jobsDir: join(store.sflowDir, 'executor'),
    registry,
    executionDelayMs: options.executorDelayMs ?? executorDelayFromEnvironment(),
  });
  const orchestrator = new Orchestrator({
    store,
    executor,
    ...(options.retryWait ? { retryWait: options.retryWait } : {}),
  });
  const app = Fastify({ logger: options.logger ?? false });

  // Install the error and not-found handlers before routes register so every
  // route uses the Project Server error shape.
  installErrorHandler(app);

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);

  registerAuthGuard(app, session);
  registerAuthRoutes(app, store, session);
  registerNodeRoutes(app, manifests);
  registerWidgetRoutes(app);
  registerWorkspaceRoutes(app, store);
  registerRunRoutes(app, store, orchestrator, manifests);
  registerAgentPatchRoutes(app, store, manifests);
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
    // Stop monitoring before closing the store. Active Run/Task/executor state
    // stays persisted so the next Server process can reconcile and resume it.
    await orchestrator.close();
    store.close();
  });

  // Rebuild any Runs that were active when the previous process stopped.
  await orchestrator.reconcileAll();

  return {
    app,
    store,
    session,
    orchestrator,
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
