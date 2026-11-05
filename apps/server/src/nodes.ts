import type { FastifyInstance } from 'fastify';
import { NodeManifestParamsSchema } from '@sflow/domain';
import { builtinManifestById, builtinManifests } from '@sflow/nodes';
import { HttpError, parseOrThrow } from './errors';

/**
 * Node Manifest catalog. The Node Library is derived entirely from these
 * declarations: categories, search text, ports, generated parameter forms,
 * resources, and Metric metadata. Model execution is not exposed here.
 */
export function registerNodeRoutes(app: FastifyInstance): void {
  app.get('/api/nodes', async () => ({ nodes: builtinManifests }));

  app.get('/api/nodes/:id', async (request) => {
    const { id } = parseOrThrow(NodeManifestParamsSchema, request.params);
    const manifest = builtinManifestById(id);
    if (!manifest) {
      throw new HttpError(404, 'NOT_FOUND', 'Node Manifest not found.');
    }
    return manifest;
  });
}
