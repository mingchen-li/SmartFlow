import { z } from 'zod';
import { NodeManifestSchema } from './workflow';

/**
 * Project-scoped custom Node packages (ticket #14).
 *
 * A custom Node is trusted Project code: a directory containing
 * `manifest.json` (strict `NodeManifest`) and `index.mjs` exporting
 * `run(input, params, context)`. Installation validates both before any bytes
 * are written, then copies the package under `.sflow/nodes/<id>/<version>/`.
 * A public marketplace and cross-Project distribution are out of scope.
 */

export const InstallNodeRequestSchema = z.strictObject({
  /** Project-relative directory containing manifest.json and index.mjs. */
  path: z.string().min(1).max(4_096),
});
export type InstallNodeRequest = z.infer<typeof InstallNodeRequestSchema>;

/**
 * Catalog metadata for an installed package. The Manifest remains the
 * scientific contract; `path` records the Project-relative install location.
 */
export const InstalledNodeSchema = z.strictObject({
  manifestId: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
  manifest: NodeManifestSchema,
  path: z.string().min(1),
  installedAt: z.string().min(1),
});
export type InstalledNode = z.infer<typeof InstalledNodeSchema>;

export const InstallNodeResponseSchema = z.strictObject({
  node: InstalledNodeSchema,
});
export type InstallNodeResponse = z.infer<typeof InstallNodeResponseSchema>;

export const UninstallNodeResponseSchema = z.strictObject({
  removed: z.literal(true),
  manifestId: z.string().min(1),
});
export type UninstallNodeResponse = z.infer<typeof UninstallNodeResponseSchema>;

/**
 * The Node Library catalog merges built-in Manifests with Project-installed
 * packages. Installed entries carry their install metadata so the Web
 * workspace can distinguish Project Nodes without another request.
 */
export const NodeCatalogResponseSchema = z.object({
  nodes: z.array(NodeManifestSchema),
  installed: z.array(InstalledNodeSchema),
});
export type NodeCatalogResponse = z.infer<typeof NodeCatalogResponseSchema>;
