import type { FastifyInstance } from 'fastify';
import {
  InstallNodeRequestSchema,
  NodeManifestParamsSchema,
} from '@sflow/domain';
import { HttpError, parseOrThrow } from './errors';
import type { NodeCatalog } from './node-catalog';

/**
 * Node Manifest catalog and Project-scoped package installation (ticket #14).
 *
 * The Node Library is derived entirely from Manifests: categories, search
 * text, ports, generated parameter forms, resources, and Metric metadata.
 * Model execution is not exposed here. The catalog merges built-in Nodes with
 * packages installed under `.sflow/nodes/`; it is refreshed live, so installed
 * Nodes appear and disappear without a Server restart.
 */
export function registerNodeRoutes(app: FastifyInstance, catalog: NodeCatalog): void {
  app.get('/api/nodes', async () => ({
    nodes: catalog.listManifests(),
    installed: catalog.listInstalled(),
  }));

  app.get('/api/nodes/:id', async (request) => {
    const { id } = parseOrThrow(NodeManifestParamsSchema, request.params);
    const manifest = catalog.getManifest(id);
    if (!manifest) {
      throw new HttpError(404, 'NOT_FOUND', 'Node Manifest not found.');
    }
    return manifest;
  });

  app.post('/api/nodes/install', async (request, reply) => {
    const { path } = parseOrThrow(InstallNodeRequestSchema, request.body ?? {});
    const node = await catalog.install(path);
    reply.code(201);
    return { node };
  });

  app.delete('/api/nodes/:id', async (request) => {
    const { id } = parseOrThrow(NodeManifestParamsSchema, request.params);
    return catalog.uninstall(id);
  });
}
