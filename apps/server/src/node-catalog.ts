import type {
  InstalledNode,
  NodeImplementation,
  NodeManifest,
  NodeRegistry,
} from '@sflow/domain';
import { findManifest } from '@sflow/domain';
import { HttpError } from './errors';
import {
  copyInstalledNodePackage,
  inspectNodePackage,
  loadInstalledNodeImplementation,
  removeInstalledNodeDirectory,
} from './node-package';
import type { ProjectStore, StoredInstalledNode } from './store';

/**
 * Project-scoped Node catalog (ticket #14).
 *
 * Built-in Nodes and Project-installed Node packages form one catalog. The
 * catalog is rebuilt at Server start and refreshed after installation or
 * uninstallation; routes, Workflow validation, Run snapshots, Agent patches,
 * and the local executor all read the same live registry, so an install takes
 * effect without restarting the Server.
 *
 * One installed version exists per Manifest id (the existing `installed_nodes`
 * primary key). Reinstalling a different version replaces it. Built-in
 * Manifest ids always win: installing over one is rejected rather than
 * silently replacing shipped execution behavior.
 */

export interface NodeCatalogReader {
  listManifests(): readonly NodeManifest[];
  getManifest(id: string, version?: string): NodeManifest | undefined;
  listInstalled(): InstalledNode[];
}

export interface NodeCatalog extends NodeCatalogReader {
  readonly registry: NodeRegistry;
  install(requestedPath: string): Promise<InstalledNode>;
  uninstall(manifestId: string): { removed: true; manifestId: string };
}

interface InstalledLock {
  record: InstalledNode;
  implementation: NodeImplementation;
}

export interface ProjectNodeCatalogOptions {
  projectRoot: string;
  store: ProjectStore;
  /** Built-in (or test-injected) registry; installed packages merge after it. */
  builtinRegistry: NodeRegistry;
}

function installedLock(
  manifest: NodeManifest,
  path: string,
  installedAt: string,
  implementation: NodeImplementation,
): InstalledLock {
  return {
    record: {
      manifestId: manifest.id,
      version: manifest.version,
      manifest,
      path,
      installedAt,
    },
    implementation,
  };
}

export class ProjectNodeCatalog implements NodeCatalog {
  readonly registry: NodeRegistry;

  private readonly projectRoot: string;
  private readonly store: ProjectStore;
  private readonly builtins: readonly NodeImplementation[];
  private readonly builtinIds: ReadonlySet<string>;
  private installed = new Map<string, InstalledLock>();

  constructor(options: ProjectNodeCatalogOptions) {
    this.projectRoot = options.projectRoot;
    this.store = options.store;
    this.builtins = options.builtinRegistry.list();
    this.builtinIds = new Set(this.builtins.map((implementation) => implementation.manifest.id));

    this.registry = {
      get: (manifestId, manifestVersion) => {
        // Built-in Manifests are never shadowed by Project packages.
        const builtIn = this.builtins.find(
          (implementation) =>
            implementation.manifest.id === manifestId &&
            implementation.manifest.version === manifestVersion,
        );
        if (builtIn) return builtIn;
        const installed = this.installed.get(manifestId);
        return installed && installed.record.version === manifestVersion
          ? installed.implementation
          : undefined;
      },
      list: () => [
        ...this.builtins,
        ...[...this.installed.values()].map((lock) => lock.implementation),
      ],
    };
  }

  /**
   * Rebuilds the installed half of the catalog from Project state. A package
   * that no longer loads stays discoverable (its Manifest is valid) but fails
   * its Task with an actionable message instead of taking down the Server.
   */
  async initialize(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const records: StoredInstalledNode[] = this.store.listInstalledNodes();
    const next = new Map<string, InstalledLock>();
    for (const record of records) {
      if (this.builtinIds.has(record.manifest.id)) continue;
      const implementation = await loadInstalledNodeImplementation(
        this.projectRoot,
        record.manifest,
        record.path,
      );
      next.set(
        record.manifest.id,
        installedLock(record.manifest, record.path, record.installedAt, implementation),
      );
    }
    this.installed = next;
  }

  listManifests(): readonly NodeManifest[] {
    return [
      ...this.builtins.map((implementation) => implementation.manifest),
      ...[...this.installed.values()].map((lock) => lock.record.manifest),
    ];
  }

  getManifest(id: string, version?: string): NodeManifest | undefined {
    const manifests = this.listManifests();
    return findManifest(manifests, id, version);
  }

  listInstalled(): InstalledNode[] {
    return [...this.installed.values()].map((lock) => lock.record);
  }

  getInstalled(manifestId: string): InstalledNode | undefined {
    return this.installed.get(manifestId)?.record;
  }

  async install(requestedPath: string): Promise<InstalledNode> {
    const inspected = await inspectNodePackage(this.projectRoot, requestedPath);
    const { manifest } = inspected;

    if (this.builtinIds.has(manifest.id)) {
      throw new HttpError(
        409,
        'NODE_ID_CONFLICT',
        `A built-in Node already uses the Manifest id "${manifest.id}". Built-in Nodes cannot be replaced by a Project package in this version of SFlow.`,
      );
    }

    const copied = await copyInstalledNodePackage(this.projectRoot, inspected);
    const installedAt = new Date().toISOString();
    const lock = installedLock(manifest, copied.path, installedAt, copied.implementation);

    try {
      this.store.saveInstalledNode({ manifest, path: copied.path, installedAt });
    } catch (error) {
      // Persistence failed: do not leave package bytes that no record owns.
      removeInstalledNodeDirectory(this.projectRoot, copied.path);
      throw error;
    }

    this.installed.set(manifest.id, lock);
    return lock.record;
  }

  uninstall(manifestId: string): { removed: true; manifestId: string } {
    if (this.builtinIds.has(manifestId)) {
      throw new HttpError(
        409,
        'BUILT_IN_NODE',
        `"${manifestId}" is a built-in Node and cannot be uninstalled from the Project.`,
      );
    }

    const installed = this.installed.get(manifestId);
    if (!installed) {
      throw new HttpError(404, 'NOT_FOUND', 'Installed Node not found.');
    }

    this.store.deleteInstalledNode(manifestId);
    removeInstalledNodeDirectory(this.projectRoot, installed.record.path);
    this.installed.delete(manifestId);
    return { removed: true, manifestId };
  }
}
