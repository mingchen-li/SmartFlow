import type { FastifyInstance } from 'fastify';
import { NodeManifestParamsSchema, type NodeRegistry } from '@sflow/domain';
import { HttpError, parseOrThrow } from './errors';

/**
 * Node Manifest catalog. The Node Library is derived entirely from these
 * declarations: categories, search text, ports, generated parameter forms,
 * resources, and Metric metadata. Model execution is not exposed here.
 */
export function registerNodeRoutes(app: FastifyInstance, registry: NodeRegistry): void {
  const manifests = registry.list().map((implementation) => implementation.manifest);

  app.get('/api/nodes', async () => ({ nodes: manifests }));

  app.get('/api/nodes/:id', async (request) => {
    const { id } = parseOrThrow(NodeManifestParamsSchema, request.params);
    const manifest = manifests.find((candidate) => candidate.id === id);
    if (!manifest) {
      throw new HttpError(404, 'NOT_FOUND', 'Node Manifest not found.');
    }
    return manifest;
  });
}
