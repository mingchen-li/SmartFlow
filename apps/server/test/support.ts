import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeImplementation, NodeRegistry } from '@sflow/domain';
import { createProjectServer, type ProjectServer } from '@sflow/server';

export interface TestServerHandle {
  server: ProjectServer;
  url: string;
  projectRoot: string;
  credential: string;
  generatedCredential?: string;
  close(options?: { cleanupProject?: boolean }): Promise<void>;
}

export interface BootTestServerOptions {
  credential?: string;
  generateCredential?: boolean;
  projectRoot?: string;
  webDist?: string;
  executorDelayMs?: number;
  registry?: NodeRegistry;
  nodeImplementations?: readonly NodeImplementation[];
  retryWait?: (milliseconds: number, signal: AbortSignal) => Promise<boolean>;
}

/**
 * Boots the real Project Server on an ephemeral port with a temporary Project
 * directory. Tests use HTTP only; nothing reaches into Fastify internals.
 */
export async function bootTestServer(options: BootTestServerOptions = {}): Promise<TestServerHandle> {
  const projectRoot = options.projectRoot ?? mkdtempSync(join(tmpdir(), 'sflow-test-'));
  const credential = options.credential ?? 'test-credential';
  const server = await createProjectServer({
    projectRoot,
    credential: options.generateCredential ? undefined : credential,
    webDist: options.webDist,
    executorDelayMs: options.executorDelayMs,
    ...(options.registry ? { registry: options.registry } : {}),
    ...(options.nodeImplementations
      ? { nodeImplementations: options.nodeImplementations }
      : {}),
    ...(options.retryWait ? { retryWait: options.retryWait } : {}),
  });
  const { url } = await server.listen(0, '127.0.0.1');

  return {
    server,
    url,
    projectRoot,
    credential,
    generatedCredential: server.generatedCredential,
    async close({ cleanupProject = !options.projectRoot } = {}) {
      await server.close();
      if (cleanupProject) rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

export async function getJson(url: string, cookie?: string): Promise<Response> {
  return fetch(url, { headers: cookie ? { cookie } : undefined });
}

export async function postJson(url: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

export async function putJson(url: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(url, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

export async function readJson<T = unknown>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Extracts `sflow_session=<value>` from a login response for use as a Cookie header. */
export function sessionCookie(response: Response): string | undefined {
  const setCookie = response.headers.getSetCookie().find((value) => value.startsWith('sflow_session='));
  return setCookie?.split(';')[0];
}

export async function login(baseUrl: string, credential: string): Promise<Response> {
  return postJson(`${baseUrl}/api/auth/login`, { credential });
}

export function tempProjectRoot(): string {
  return mkdtempSync(join(tmpdir(), 'sflow-test-'));
}
