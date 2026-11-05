import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  NodeExecutionError,
  NodeManifestSchema,
  type NodeImplementation,
  type NodeManifest,
  type NodeRunContext,
  type NodeRunResult,
} from '@sflow/domain';
import { HttpError } from './errors';

/**
 * Custom Node package inspection and installation (ticket #14).
 *
 * Packages are trusted Project code. Every rejection happens before the
 * catalog, database, or `.sflow/nodes` destination is touched, so a failed
 * install can never leave a partially installed Node. The Manifest is parsed
 * with the strict `NodeManifestSchema`; the module must be importable and
 * export `run`.
 */

export interface NodePackageDiagnostic {
  path: string;
  message: string;
}

export interface InspectedNodePackage {
  manifest: NodeManifest;
  /** Absolute directory of the validated source package. */
  sourceDirectory: string;
  /** Project-relative normalized source path. */
  sourcePath: string;
}

export type NodePackageRun = (
  input: Record<string, unknown>,
  params: Record<string, unknown>,
  context: NodeRunContext,
) => NodeRunResult | Promise<NodeRunResult>;

interface PackageModule {
  run: NodePackageRun;
}

const SAFE_DIRECTORY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SFLOW_STATE_DIRECTORY = '.sflow';

function invalidPackage(
  message: string,
  diagnostics: readonly NodePackageDiagnostic[],
): HttpError {
  return new HttpError(422, 'INVALID_NODE_PACKAGE', message, { diagnostics });
}

function invalidPath(message: string): HttpError {
  return new HttpError(400, 'INVALID_PATH', message);
}

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Normalizes a Project-relative package path. The source must be ordinary
 * Project content: no absolute paths, parent traversal, or `.sflow/` state.
 */
export function normalizeNodePackagePath(input: string): string {
  const raw = input.trim();
  if (!raw) {
    throw invalidPath('A Project-relative Node package path is required.');
  }
  if (isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw invalidPath('Node package paths must be relative to the Project root.');
  }

  const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = normalized.split('/');
  if (
    !normalized ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw invalidPath('Node package paths must stay inside the Project.');
  }
  if (segments.includes(SFLOW_STATE_DIRECTORY)) {
    throw invalidPath(
      'Node packages must live in the Project filesystem, not inside SFlow Project state.',
    );
  }

  return normalized;
}

function importPackageModule(indexPath: string): Promise<PackageModule> {
  // A unique query busts the ESM cache when an installed Node is replaced.
  const url = `${pathToFileURL(indexPath).href}?sflow=${randomUUID()}`;
  return import(url) as Promise<PackageModule>;
}

function moduleDiagnostic(error: unknown): string {
  return error instanceof Error ? error.message : 'The Node module could not be loaded.';
}

/**
 * Reads and validates one candidate package without writing anything. Throws
 * an HTTP 422 `INVALID_NODE_PACKAGE` with path-addressed diagnostics.
 */
export async function inspectNodePackage(
  projectRoot: string,
  requestedPath: string,
): Promise<InspectedNodePackage> {
  const sourcePath = normalizeNodePackagePath(requestedPath);
  const absoluteSource = resolve(projectRoot, sourcePath);

  let realSource: string;
  try {
    const projectReal = realpathSync(projectRoot);
    realSource = realpathSync(absoluteSource);
    if (realSource !== projectReal && !isInside(projectReal, realSource)) {
      throw invalidPath('Node package paths must stay inside the Project.');
    }
    if (!statSync(realSource).isDirectory()) {
      throw invalidPackage(
        `The Node package path "${sourcePath}" is not a directory.`,
        [{ path: 'path', message: `"${sourcePath}" must be a package directory.` }],
      );
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw invalidPackage(
      `The Node package directory "${sourcePath}" does not exist in the Project.`,
      [
        {
          path: 'path',
          message: `Create "${sourcePath}" with manifest.json and index.mjs, or select the Project-relative directory that contains them.`,
        },
      ],
    );
  }

  const diagnostics: NodePackageDiagnostic[] = [];
  const manifestPath = join(realSource, 'manifest.json');
  let manifestJson: unknown;

  try {
    if (!statSync(manifestPath).isFile()) throw new Error('not a file');
    const contents = readFileSync(manifestPath, 'utf8');
    try {
      manifestJson = JSON.parse(contents);
    } catch (error) {
      diagnostics.push({
        path: 'manifest.json',
        message: `manifest.json is not valid JSON: ${moduleDiagnostic(error)}`,
      });
    }
  } catch {
    diagnostics.push({
      path: 'manifest.json',
      message: 'The package must contain a manifest.json file.',
    });
  }

  let manifest: NodeManifest | undefined;
  if (manifestJson !== undefined) {
    const parsed = NodeManifestSchema.safeParse(manifestJson);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        diagnostics.push({
          path: ['manifest.json', ...issue.path.map(String)].join('.'),
          message: issue.message,
        });
      }
    } else {
      manifest = parsed.data;
      for (const field of ['id', 'version'] as const) {
        if (!SAFE_DIRECTORY_SEGMENT.test(manifest[field])) {
          diagnostics.push({
            path: `manifest.json.${field}`,
            message: `The Manifest ${field} "${manifest[field]}" must be a safe single Project directory name (letters, digits, ".", "_", or "-").`,
          });
        }
      }
    }
  }

  const indexPath = join(realSource, 'index.mjs');
  let packageModule: PackageModule | undefined;
  try {
    if (!statSync(indexPath).isFile()) throw new Error('not a file');
    packageModule = await importPackageModule(indexPath);
    if (typeof packageModule.run !== 'function') {
      diagnostics.push({
        path: 'index.mjs',
        message: 'The Node package must export a run(input, params, context) function.',
      });
    }
  } catch (error) {
    diagnostics.push({
      path: 'index.mjs',
      message:
        error instanceof Error && error.message !== 'not a file'
          ? `The Node module could not be loaded: ${moduleDiagnostic(error)}`
          : 'The package must contain an index.mjs file exporting run(input, params, context).',
    });
  }

  if (diagnostics.length > 0 || !manifest || !packageModule) {
    throw invalidPackage(
      `The Node package at "${sourcePath}" does not satisfy the Node contract.`,
      diagnostics,
    );
  }

  return { manifest, sourceDirectory: realSource, sourcePath };
}

export function nodeImplementation(
  manifest: NodeManifest,
  run: NodePackageRun,
): NodeImplementation {
  return {
    manifest,
    run: (input, params, context) => run(input, params, context),
  };
}

/** A persisted package that no longer loads fails its Task with this message. */
export function unavailableNodeImplementation(
  manifest: NodeManifest,
  message: string,
): NodeImplementation {
  return {
    manifest,
    run: () => {
      throw new NodeExecutionError('validation', message);
    },
  };
}

/** Project-relative install location for one validated Manifest version. */
export function installedNodePath(manifest: NodeManifest): string {
  return `.sflow/nodes/${manifest.id}/${manifest.version}`;
}

export interface InstalledNodePackageFiles {
  /** Project-relative install location. */
  path: string;
  implementation: NodeImplementation;
}

/**
 * Copies a validated package into `.sflow/nodes/<id>/<version>/`.
 *
 * The copy is staged first and only swapped into place once complete. A
 * previous installed version is moved aside and restored if the new module
 * cannot be imported from its installed location, so the catalog never points
 * at a half-written package.
 */
export async function copyInstalledNodePackage(
  projectRoot: string,
  inspected: InspectedNodePackage,
): Promise<InstalledNodePackageFiles> {
  const { manifest } = inspected;
  const nodesDir = join(projectRoot, '.sflow', 'nodes');
  const idDirectory = join(nodesDir, manifest.id);
  const target = join(idDirectory, manifest.version);
  const staging = join(idDirectory, `.staging-${randomUUID()}`);
  const backup = `${target}.backup-${randomUUID()}`;

  mkdirSync(idDirectory, { recursive: true });
  try {
    cpSync(inspected.sourceDirectory, staging, { recursive: true });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw new HttpError(
      500,
      'NODE_INSTALL_FAILED',
      `The Node package could not be copied into the Project: ${moduleDiagnostic(error)}`,
    );
  }

  let movedPrevious = false;
  let movedNew = false;
  try {
    if (existsSync(target)) {
      renameSync(target, backup);
      movedPrevious = true;
    }
    renameSync(staging, target);
    movedNew = true;

    let installedModule: PackageModule;
    try {
      installedModule = await importPackageModule(join(target, 'index.mjs'));
    } catch (error) {
      throw invalidPackage(
        `The copied Node package could not be loaded: ${moduleDiagnostic(error)}`,
        [{ path: 'index.mjs', message: moduleDiagnostic(error) }],
      );
    }
    if (typeof installedModule.run !== 'function') {
      throw invalidPackage('The copied Node package does not export run.', [
        { path: 'index.mjs', message: 'The Node package must export run.' },
      ]);
    }

    if (movedPrevious) rmSync(backup, { recursive: true, force: true });
    // One installed version per Manifest id: an upgrade replaces the old
    // version directory rather than accumulating versions in the Project.
    for (const entry of readdirSync(idDirectory)) {
      if (entry === manifest.version) continue;
      rmSync(join(idDirectory, entry), { recursive: true, force: true });
    }
    return {
      path: installedNodePath(manifest),
      implementation: nodeImplementation(manifest, installedModule.run),
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (movedNew) rmSync(target, { recursive: true, force: true });
    if (movedPrevious && existsSync(backup)) renameSync(backup, target);
    throw error;
  }
}

/**
 * Loads an already installed package during catalog refresh. A broken package
 * must not prevent the Server from starting, so the returned implementation
 * reports a diagnosable execution failure instead of throwing at startup.
 */
export async function loadInstalledNodeImplementation(
  projectRoot: string,
  manifest: NodeManifest,
  installedPath: string,
): Promise<NodeImplementation> {
  const nodesDir = resolve(projectRoot, '.sflow', 'nodes');
  const absolute = resolve(projectRoot, installedPath);
  if (!isInside(nodesDir, absolute)) {
    return unavailableNodeImplementation(
      manifest,
      `The installed Node package path "${installedPath}" is outside the Project Node directory. Reinstall the package.`,
    );
  }

  try {
    const installedModule = await importPackageModule(join(absolute, 'index.mjs'));
    if (typeof installedModule.run !== 'function') {
      throw new Error('The Node package does not export run.');
    }
    return nodeImplementation(manifest, installedModule.run);
  } catch (error) {
    return unavailableNodeImplementation(
      manifest,
      `The installed Node package "${manifest.id}@${manifest.version}" could not be loaded: ${moduleDiagnostic(error)} Reinstall the package.`,
    );
  }
}

/**
 * Removes one installed package directory. The path is derived from validated
 * Manifest id/version or read from the store; either way it must stay under
 * `.sflow/nodes/`, so a corrupted record cannot delete Project content.
 */
export function removeInstalledNodeDirectory(
  projectRoot: string,
  installedPath: string,
): void {
  const nodesDir = resolve(projectRoot, '.sflow', 'nodes');
  const absolute = resolve(projectRoot, installedPath);
  if (!isInside(nodesDir, absolute) && absolute !== nodesDir) {
    return;
  }
  // One version per Manifest id: remove the id directory that holds it.
  const idDirectory = dirname(absolute);
  if (dirname(idDirectory) !== nodesDir) return;
  rmSync(idDirectory, { recursive: true, force: true });
}
