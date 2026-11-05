import type { FastifyInstance } from 'fastify';
import { NodeManifestParamsSchema, findManifest, type NodeManifest } from '@sflow/domain';
import { builtinManifests } from '@sflow/nodes';
import { HttpError, parseOrThrow } from './errors';

/**
 * Node Manifest catalog. The Node Library is derived entirely from these
 * declarations: categories, search text, ports, generated parameter forms,
 * resources, and Metric metadata. Model execution is not exposed here.
 *
 * The catalog is the installed registry's Manifest set, so a Server can expose
 * replacement implementations or additional Manifest versions through the
 * same route without changing the Web client.
 */
export function registerNodeRoutes(
  app: FastifyInstance,
  manifests: readonly NodeManifest[] = builtinManifests,
): void {
  app.get('/api/nodes', async () => ({ nodes: manifests }));

  app.get('/api/nodes/:id', async (request) => {
    const { id } = parseOrThrow(NodeManifestParamsSchema, request.params);
    const manifest = findManifest(manifests, id);
    if (!manifest) {
      throw new HttpError(404, 'NOT_FOUND', 'Node Manifest not found.');
    }
    return manifest;
  });
}
