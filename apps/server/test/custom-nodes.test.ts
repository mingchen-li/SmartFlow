import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CreateRunResponse,
  ErrorResponse,
  FileReference,
  InstalledNode,
  NodeCatalogResponse,
  NodeManifest,
  RunDetailResponse,
  RunSnapshot,
  TaskLogsResponse,
  ValidateWorkflowResponse,
  WorkflowDraft,
  WorkflowIR,
} from '@sflow/domain';
import type {
  CommandInvocation,
  CommandResult,
  CommandRunner,
} from '@sflow/orchestrator';
import {
  bootTestServer,
  getJson,
  login,
  postJson,
  putJson,
  readJson,
  sessionCookie,
  type TestServerHandle,
} from './support';
import {
  DRAFT_ID,
  TARGET_PDB,
  buildWorkflow,
  emptyLayout,
} from './workflow-fixture';

/**
 * Project-scoped custom Node installation (ticket #14).
 *
 * A package is a Project-relative directory with `manifest.json` and an
 * `index.mjs` exporting `run`. Installation validates both before writing, then
 * makes the Node available to the catalog, Workflow validation, Run snapshots,
 * Agent patches, and execution without restarting the Server.
 */

const ECHO_MANIFEST: NodeManifest = {
  id: 'echo-node',
  version: '1.0.0',
  name: 'Echo Node',
  description: 'Emit a deterministic greeting derived from its parameters.',
  category: 'Custom',
  type: 'transform',
  inputs: [
    {
      id: 'value',
      name: 'Value',
      direction: 'input',
      kind: 'data',
      dataType: 'any',
    },
  ],
  outputs: [
    {
      id: 'echoed',
      name: 'Echoed value',
      direction: 'output',
      kind: 'data',
      dataType: 'any',
    },
  ],
  parameters: [
    {
      id: 'greeting',
      name: 'Greeting',
      type: 'string',
      default: 'hello',
      required: true,
    },
  ],
  metrics: [
    {
      id: 'echoLength',
      name: 'Echo length',
      description: 'Characters in the echoed greeting.',
      valueType: 'number',
      direction: 'neutral',
    },
  ],
  resources: { cpu: 1, memory: '1Gi', walltimeMinutes: 5 },
  environment: {
    kind: 'container',
    image: 'ghcr.io/sflow/examples/echo-node:1.0.0',
    command: ['run-echo'],
    variables: { ECHO_MODE: 'deterministic' },
  },
  retry: { maxAttempts: 1, backoffSeconds: 0, retryOn: [] },
};

const ECHO_INDEX = `export function run(input, params, context) {
  const greeting = typeof params.greeting === 'string' ? params.greeting : 'hello';
  context.log('echo greeting=' + greeting);
  context.writeFile('echo.json', JSON.stringify({ greeting }) + '\\n');
  return {
    outputs: [
      {
        portId: 'echoed',
        value: greeting,
        artifacts: [
          {
            name: 'echo.json',
            relativePath: 'echo.json',
            mediaType: 'application/json',
          },
        ],
      },
    ],
    metrics: { echoLength: greeting.length },
  };
}
`;

interface PackageOptions {
  manifest?: unknown;
  manifestText?: string;
  indexText?: string | null;
  omitManifest?: boolean;
  omitIndex?: boolean;
}

/** Writes a candidate Node package into the Project under `node-packages/`. */
function writePackage(
  projectRoot: string,
  directory: string,
  options: PackageOptions = {},
): string {
  const root = join(projectRoot, 'node-packages', directory);
  mkdirSync(root, { recursive: true });
  if (!options.omitManifest) {
    writeFileSync(
      join(root, 'manifest.json'),
      options.manifestText ?? JSON.stringify(options.manifest ?? ECHO_MANIFEST, null, 2),
    );
  }
  if (!options.omitIndex) {
    writeFileSync(join(root, 'index.mjs'), options.indexText ?? ECHO_INDEX);
  }
  return `node-packages/${directory}`;
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function argument(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

interface SchedulerJob {
  taskDir: string;
  outputTemplate: string;
  script: string;
  polls: number;
}

/**
 * Minimal Slurm scheduler stand-in. It records the generated batch script for
 * each Job and completes every Job deterministically, so the test can assert
 * the installed Manifest's declared container environment reached the
 * production execution path without a real scheduler or network.
 */
class CompletingScheduler implements CommandRunner {
  readonly calls: CommandInvocation[] = [];
  readonly jobs = new Map<string, SchedulerJob>();
  private nextId = 9001;

  async run(invocation: CommandInvocation): Promise<CommandResult> {
    this.calls.push(invocation);
    if (invocation.command === 'sbatch') {
      const id = String(this.nextId++);
      const scriptPath = invocation.args.at(-1) ?? '';
      this.jobs.set(id, {
        taskDir: argument(invocation.args, '--chdir') ?? '',
        outputTemplate: argument(invocation.args, '--output') ?? '',
        script: readFileSync(scriptPath, 'utf8'),
        polls: 0,
      });
      return ok(`${id};test-cluster\n`);
    }

    const jobId = invocation.args
      .map((value) => /^--jobs?=(.+)$/.exec(value)?.[1])
      .find((value) => value !== undefined);
    const job = jobId ? this.jobs.get(jobId) : undefined;
    if (invocation.command === 'squeue' && job) {
      job.polls += 1;
      if (job.polls < 2) return ok('RUNNING\n');
      this.complete(jobId!, job);
      return ok('');
    }
    if (invocation.command === 'sacct' && job) {
      return ok(`${jobId}|COMPLETED|0:0\n`);
    }
    return ok('');
  }

  private complete(jobId: string, job: SchedulerJob): void {
    mkdirSync(job.taskDir, { recursive: true });
    writeFileSync(
      job.outputTemplate.replace('%j', jobId).replace('%A', jobId),
      `slurm_job=${jobId}\ncustom node completed\n`,
    );
    writeFileSync(join(job.taskDir, 'result.json'), JSON.stringify({ outputs: [], metrics: [] }));
  }
}

async function waitForTerminal(
  handle: TestServerHandle,
  cookie: string,
  runId: string,
): Promise<RunDetailResponse> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const detail = await readJson<RunDetailResponse>(
      await getJson(`${handle.url}/api/runs/${runId}`, cookie),
    );
    if (['completed', 'failed', 'canceled'].includes(detail.run.status)) return detail;
    if (Date.now() > deadline) throw new Error(`Run ${runId} did not finish.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('Project-scoped custom Node installation', () => {
  let handle: TestServerHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function signIn(): Promise<string> {
    handle = await bootTestServer();
    const accepted = await login(handle.url, handle.credential);
    return sessionCookie(accepted)!;
  }

  async function catalog(cookie: string): Promise<NodeCatalogResponse> {
    const response = await getJson(`${handle!.url}/api/nodes`, cookie);
    expect(response.status).toBe(200);
    return readJson<NodeCatalogResponse>(response);
  }

  async function install(
    cookie: string,
    path: string,
  ): Promise<{ status: number; body: unknown }> {
    const response = await postJson(`${handle!.url}/api/nodes/install`, { path }, cookie);
    return { status: response.status, body: await readJson(response) };
  }

  async function saveWorkflow(cookie: string, workflow: WorkflowIR): Promise<WorkflowDraft> {
    const response = await putJson(
      `${handle!.url}/api/workflows/${DRAFT_ID}`,
      { name: 'Binder design', workflow, layout: emptyLayout },
      cookie,
    );
    expect(response.status).toBe(200);
    return readJson<WorkflowDraft>(response);
  }

  function workflowWithEchoNode(): WorkflowIR {
    return {
      version: 1,
      id: DRAFT_ID,
      name: 'Binder design',
      nodes: [
        {
          id: 'node-echo',
          manifestId: ECHO_MANIFEST.id,
          manifestVersion: ECHO_MANIFEST.version,
          label: 'Echo Node',
          parameters: { greeting: 'hola' },
          resources: {},
        },
      ],
      edges: [],
    };
  }

  /**
   * A Workflow that satisfies the Binder output contract. Server validation
   * enforces the Binder required outputs, so installed Nodes are always
   * exercised beside a valid Binder DAG.
   */
  async function binderWorkflow(cookie: string): Promise<WorkflowIR> {
    mkdirSync(join(handle!.projectRoot, 'targets'), { recursive: true });
    writeFileSync(join(handle!.projectRoot, 'targets', 'target.pdb'), TARGET_PDB);
    const registered = await postJson(
      `${handle!.url}/api/files`,
      { path: 'targets/target.pdb' },
      cookie,
    );
    expect(registered.status).toBe(200);
    const fileReference = await readJson<FileReference>(registered);
    return buildWorkflow(fileReference);
  }

  async function binderWorkflowWithEcho(cookie: string): Promise<WorkflowIR> {
    const workflow = await binderWorkflow(cookie);
    workflow.nodes.push(workflowWithEchoNode().nodes[0]!);
    return workflow;
  }

  it('requires authentication to install, list, read, and uninstall Nodes', async () => {
    handle = await bootTestServer();

    const installResponse = await postJson(`${handle.url}/api/nodes/install`, {
      path: 'node-packages/echo',
    });
    expect(installResponse.status).toBe(401);

    const deleteResponse = await fetch(`${handle.url}/api/nodes/echo-node`, {
      method: 'DELETE',
    });
    expect(deleteResponse.status).toBe(401);

    const listResponse = await getJson(`${handle.url}/api/nodes`);
    expect(listResponse.status).toBe(401);
  });

  it('rejects a package whose Manifest fails the strict Node Manifest contract', async () => {
    const cookie = await signIn();
    const invalidManifest = {
      ...ECHO_MANIFEST,
      environment: undefined,
      strayLayoutField: { x: 10, y: 20 },
    };
    const path = writePackage(handle!.projectRoot, 'invalid-manifest', {
      manifest: invalidManifest,
    });

    const rejected = await install(cookie, path);
    expect(rejected.status).toBe(422);
    const error = rejected.body as ErrorResponse;
    expect(error.error.code).toBe('INVALID_NODE_PACKAGE');
    const diagnostics = (error.error.details as {
      diagnostics: Array<{ path: string; message: string }>;
    }).diagnostics;
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.map((entry) => entry.path).join(' ')).toContain('manifest.json');
    expect(diagnostics.some((entry) => /environment/.test(entry.message + entry.path))).toBe(
      true,
    );

    // No partial install: nothing reached the catalog or the Project state.
    const listed = await catalog(cookie);
    expect(listed.nodes.map((node) => node.id)).not.toContain('echo-node');
    expect(
      readdirSync(join(handle!.projectRoot, '.sflow', 'nodes')),
    ).toEqual([]);
  });

  it('rejects a package that is not a valid Project-relative directory', async () => {
    const cookie = await signIn();

    for (const path of ['/etc', '../outside', '.sflow/nodes/echo-node/1.0.0']) {
      const rejected = await install(cookie, path);
      expect(rejected.status).toBe(400);
      expect((rejected.body as ErrorResponse).error.code).toBe('INVALID_PATH');
    }

    const missing = await install(cookie, 'node-packages/does-not-exist');
    expect(missing.status).toBe(422);
    expect((missing.body as ErrorResponse).error.code).toBe('INVALID_NODE_PACKAGE');
  });

  it('rejects packages whose layout cannot supply an executable run function', async () => {
    const cookie = await signIn();

    const noIndex = writePackage(handle!.projectRoot, 'no-index', { omitIndex: true });
    const noIndexResult = await install(cookie, noIndex);
    expect(noIndexResult.status).toBe(422);
    expect(
      (noIndexResult.body as ErrorResponse).error.details as {
        diagnostics: Array<{ path: string }>;
      },
    ).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ path: 'index.mjs' }),
      ]),
    });

    const noRun = writePackage(handle!.projectRoot, 'no-run', {
      indexText: 'export const notRun = true;\n',
    });
    const noRunResult = await install(cookie, noRun);
    expect(noRunResult.status).toBe(422);
    expect(
      (noRunResult.body as ErrorResponse).error.details as {
        diagnostics: Array<{ path: string; message: string }>;
      },
    ).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          path: 'index.mjs',
          message: expect.stringContaining('run'),
        }),
      ]),
    });

    const throws = writePackage(handle!.projectRoot, 'throws', {
      indexText: 'throw new Error("cannot load");\n',
    });
    const throwsResult = await install(cookie, throws);
    expect(throwsResult.status).toBe(422);
    expect(
      (throwsResult.body as ErrorResponse).error.details as {
        diagnostics: Array<{ path: string; message: string }>;
      },
    ).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          path: 'index.mjs',
          message: expect.stringContaining('cannot load'),
        }),
      ]),
    });
  });

  it('rejects Manifest ids or versions that cannot be Project directory names', async () => {
    const cookie = await signIn();
    const path = writePackage(handle!.projectRoot, 'unsafe-id', {
      manifest: { ...ECHO_MANIFEST, id: '../escape' },
    });

    const rejected = await install(cookie, path);
    expect(rejected.status).toBe(422);
    expect(
      (rejected.body as ErrorResponse).error.details as {
        diagnostics: Array<{ path: string; message: string }>;
      },
    ).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          path: 'manifest.json.id',
          message: expect.stringContaining('safe'),
        }),
      ]),
    });
  });

  it('installs a valid Project package and exposes it without restarting the Server', async () => {
    const cookie = await signIn();
    const source = writePackage(handle!.projectRoot, 'echo');

    const installed = await install(cookie, source);
    expect(installed.status).toBe(201);
    const { node } = installed.body as { node: InstalledNode };
    expect(node.manifestId).toBe('echo-node');
    expect(node.version).toBe('1.0.0');
    expect(node.path).toBe('.sflow/nodes/echo-node/1.0.0');
    expect(node.manifest).toEqual(ECHO_MANIFEST);

    // The package is copied, not referenced: the source can be removed.
    const installedDir = join(handle!.projectRoot, node.path);
    expect(JSON.parse(readFileSync(join(installedDir, 'manifest.json'), 'utf8'))).toEqual(
      ECHO_MANIFEST,
    );
    expect(readFileSync(join(installedDir, 'index.mjs'), 'utf8')).toBe(ECHO_INDEX);
    rmSync(source, { recursive: true, force: true });

    const listed = await catalog(cookie);
    expect(listed.nodes.map((manifest) => manifest.id)).toEqual([
      'target-input',
      'candidate-generation',
      'sequence-design',
      'structure-prediction',
      'candidate-comparison',
      'echo-node',
    ]);
    const installedMetadata = listed.installed.find(
      (entry) => entry.manifestId === 'echo-node',
    )!;
    expect(installedMetadata.path).toBe('.sflow/nodes/echo-node/1.0.0');
    expect(installedMetadata.manifest.environment).toEqual(ECHO_MANIFEST.environment);
    expect(installedMetadata.manifest.retry).toEqual(ECHO_MANIFEST.retry);

    const single = await getJson(`${handle!.url}/api/nodes/echo-node`, cookie);
    expect(single.status).toBe(200);
    expect(await readJson<NodeManifest>(single)).toEqual(ECHO_MANIFEST);

    // The installed Manifest is now part of Workflow validation on the same
    // Server process, with its ports and generated-form parameters enforced.
    const workflow = await binderWorkflowWithEcho(cookie);
    await saveWorkflow(cookie, workflow);
    const validation = await readJson<ValidateWorkflowResponse>(
      await postJson(`${handle!.url}/api/workflows/${DRAFT_ID}/validate`, {}, cookie),
    );
    expect(validation.valid).toBe(true);
    expect(validation.diagnostics).toEqual([]);

    workflow.nodes.find((node) => node.id === 'node-echo')!.parameters = {
      greeting: 'hola',
      unknown: true,
    };
    await saveWorkflow(cookie, workflow);
    const invalid = await readJson<ValidateWorkflowResponse>(
      await postJson(`${handle!.url}/api/workflows/${DRAFT_ID}/validate`, {}, cookie),
    );
    expect(invalid.valid).toBe(false);
    expect(
      invalid.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'PARAMETER_ERROR' &&
          diagnostic.nodeId === 'node-echo' &&
          diagnostic.message.includes('unknown'),
      ),
    ).toBe(true);
  });

  it('replaces an installed version and refuses to shadow a built-in Manifest id', async () => {
    const cookie = await signIn();
    const first = writePackage(handle!.projectRoot, 'echo-v1');
    expect((await install(cookie, first)).status).toBe(201);

    const next = writePackage(handle!.projectRoot, 'echo-v2', {
      manifest: { ...ECHO_MANIFEST, version: '2.0.0', description: 'Second version.' },
    });
    const replaced = await install(cookie, next);
    expect(replaced.status).toBe(201);
    const { node } = replaced.body as { node: InstalledNode };
    expect(node.version).toBe('2.0.0');
    expect(readdirSync(join(handle!.projectRoot, '.sflow', 'nodes', 'echo-node'))).toEqual([
      '2.0.0',
    ]);

    const listed = await catalog(cookie);
    expect(
      listed.installed.filter((entry) => entry.manifestId === 'echo-node'),
    ).toHaveLength(1);
    expect(
      listed.nodes.filter((manifest) => manifest.id === 'echo-node').map((m) => m.version),
    ).toEqual(['2.0.0']);

    const collision = writePackage(handle!.projectRoot, 'shadow', {
      manifest: {
        ...ECHO_MANIFEST,
        id: 'target-input',
        name: 'Shadow target input',
      },
    });
    const rejected = await install(cookie, collision);
    expect(rejected.status).toBe(409);
    expect((rejected.body as ErrorResponse).error.code).toBe('NODE_ID_CONFLICT');

    // The built-in Manifest and implementation remain the catalog entry.
    const builtIn = await readJson<NodeManifest>(
      await getJson(`${handle!.url}/api/nodes/target-input`, cookie),
    );
    expect(builtIn.name).toBe('Target input');
  });

  it('uninstalls a custom Node and preserves every built-in Node', async () => {
    const cookie = await signIn();
    const path = writePackage(handle!.projectRoot, 'echo');
    expect((await install(cookie, path)).status).toBe(201);

    const removed = await fetch(`${handle!.url}/api/nodes/echo-node`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(removed.status).toBe(200);
    expect(await readJson(removed)).toEqual({ removed: true, manifestId: 'echo-node' });

    const listed = await catalog(cookie);
    expect(listed.nodes.map((manifest) => manifest.id)).toEqual([
      'target-input',
      'candidate-generation',
      'sequence-design',
      'structure-prediction',
      'candidate-comparison',
    ]);
    expect(listed.installed).toEqual([]);
    expect(readdirSync(join(handle!.projectRoot, '.sflow', 'nodes'))).toEqual([]);

    const missing = await getJson(`${handle!.url}/api/nodes/echo-node`, cookie);
    expect(missing.status).toBe(404);

    // Removing the package makes Workflows that depend on it fail validation
    // and Run creation; nothing silently falls back to another implementation.
    await saveWorkflow(cookie, workflowWithEchoNode());
    const validation = await readJson<ValidateWorkflowResponse>(
      await postJson(`${handle!.url}/api/workflows/${DRAFT_ID}/validate`, {}, cookie),
    );
    expect(validation.valid).toBe(false);
    expect(
      validation.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'UNKNOWN_MANIFEST' && diagnostic.nodeId === 'node-echo',
      ),
    ).toBe(true);

    const runResponse = await postJson(
      `${handle!.url}/api/workflows/${DRAFT_ID}/runs`,
      {},
      cookie,
    );
    expect(runResponse.status).toBe(422);

    const builtInDelete = await fetch(`${handle!.url}/api/nodes/target-input`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(builtInDelete.status).toBe(409);
    expect((await readJson<ErrorResponse>(builtInDelete)).error.code).toBe('BUILT_IN_NODE');

    const unknownDelete = await fetch(`${handle!.url}/api/nodes/not-installed`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(unknownDelete.status).toBe(404);
  });

  it('captures installed Manifest versions in immutable Run snapshots', async () => {
    const cookie = await signIn();
    const path = writePackage(handle!.projectRoot, 'echo');
    expect((await install(cookie, path)).status).toBe(201);

    // A Binder Workflow is required for Run creation. Add the custom Node as an
    // independent leaf so the run also exercises it.
    const workflow = await binderWorkflowWithEcho(cookie);
    await saveWorkflow(cookie, workflow);

    const validation = await readJson<ValidateWorkflowResponse>(
      await postJson(`${handle!.url}/api/workflows/${DRAFT_ID}/validate`, {}, cookie),
    );
    expect(validation.valid).toBe(true);

    const created = await readJson<{ run: { id: string; snapshot: RunSnapshot } }>(
      await postJson(`${handle!.url}/api/workflows/${DRAFT_ID}/runs`, {}, cookie),
    );
    const echoSnapshot = created.run.snapshot.nodes.find(
      (node) => node.manifestId === 'echo-node',
    )!;
    expect(echoSnapshot).toMatchObject({
      manifestVersion: '1.0.0',
      environment: ECHO_MANIFEST.environment,
      retry: ECHO_MANIFEST.retry,
      parameters: { greeting: 'hola' },
    });
  });

  it('accepts an Agent patch that adds an installed Node', async () => {
    const cookie = await signIn();
    const source = writePackage(handle!.projectRoot, 'echo');
    expect((await install(cookie, source)).status).toBe(201);

    const saved = await saveWorkflow(cookie, await binderWorkflow(cookie));
    const proposed = await postJson(
      `${handle!.url}/api/workflows/${DRAFT_ID}/agent/patches`,
      {
        scope: 'workflow',
        target: { kind: 'workflow', workflowId: DRAFT_ID },
        baseRevision: saved.revision,
        summary: 'Add the installed Echo Node.',
        operations: [
          {
            op: 'add',
            path: '/nodes/-',
            value: workflowWithEchoNode().nodes[0]!,
          },
        ],
      },
      cookie,
    );

    expect(proposed.status).toBe(201);
    const { patch } = await readJson<{
      patch: { status: string; validation: { valid: boolean } };
    }>(proposed);
    expect(patch.status).toBe('proposed');
    expect(patch.validation.valid).toBe(true);
  });

  it('executes an installed Node locally and records its outputs, Metrics, and logs', async () => {
    const cookie = await signIn();
    const source = writePackage(handle!.projectRoot, 'echo');
    expect((await install(cookie, source)).status).toBe(201);
    await saveWorkflow(cookie, await binderWorkflowWithEcho(cookie));

    const created = await readJson<CreateRunResponse>(
      await postJson(`${handle!.url}/api/workflows/${DRAFT_ID}/runs`, {}, cookie),
    );
    const detail = await waitForTerminal(handle!, cookie, created.run.id);

    expect(detail.run.status).toBe('completed');
    const echoTask = detail.tasks.find((task) => task.nodeId === 'node-echo')!;
    expect(echoTask.state).toBe('completed');
    expect(echoTask.exitCode).toBe(0);
    expect(echoTask.logsAvailable).toBe(true);

    const logs = await readJson<TaskLogsResponse>(
      await getJson(
        `${handle!.url}/api/runs/${created.run.id}/tasks/${echoTask.id}/logs`,
        cookie,
      ),
    );
    expect(logs.lines).toEqual(
      expect.arrayContaining(['node=echo-node attempt=1', 'echo greeting=hola']),
    );

    const artifact = detail.artifacts.find((entry) => entry.nodeId === 'node-echo')!;
    expect(artifact.name).toBe('echo.json');
    expect(artifact.mediaType).toBe('application/json');
    const metric = detail.metrics.find(
      (entry) => entry.nodeId === 'node-echo' && entry.metricId === 'echoLength',
    )!;
    expect(metric.value).toBe(4);
    expect(metric.schema).toMatchObject({
      namespace: 'sflow.binder.echo-node',
      name: 'echoLength',
      version: '1.0.0',
    });
  });

  it('restores an installed Node from Project state after a Server restart', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'sflow-custom-restart-'));
    try {
      handle = await bootTestServer({ projectRoot });
      let accepted = await login(handle.url, handle.credential);
      let cookie = sessionCookie(accepted)!;
      const source = writePackage(projectRoot, 'echo');
      expect((await install(cookie, source)).status).toBe(201);

      // Stop the Server without deleting the Project. The next process has no
      // in-memory catalog and must rebuild it from the installed_nodes record
      // and the copied package.
      await handle.close({ cleanupProject: false });
      handle = undefined;

      handle = await bootTestServer({ projectRoot });
      accepted = await login(handle.url, handle.credential);
      cookie = sessionCookie(accepted)!;

      const listed = await catalog(cookie);
      expect(listed.installed.map((entry) => entry.manifestId)).toEqual(['echo-node']);
      expect(listed.nodes.some((manifest) => manifest.id === 'echo-node')).toBe(true);

      await saveWorkflow(cookie, await binderWorkflowWithEcho(cookie));
      const created = await readJson<CreateRunResponse>(
        await postJson(`${handle.url}/api/workflows/${DRAFT_ID}/runs`, {}, cookie),
      );
      const detail = await waitForTerminal(handle, cookie, created.run.id);
      expect(detail.run.status).toBe('completed');
      expect(
        detail.tasks.find((task) => task.nodeId === 'node-echo')!.state,
      ).toBe('completed');
    } finally {
      await handle?.close();
      handle = undefined;
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('surfaces an installed Node execution failure as a diagnosable Task failure', async () => {
    const cookie = await signIn();
    const source = writePackage(handle!.projectRoot, 'failing', {
      indexText:
        'export function run(input, params, context) {\n' +
        "  context.log('custom run started');\n" +
        "  throw new Error('deterministic custom Node failure');\n" +
        '}\n',
    });
    expect((await install(cookie, source)).status).toBe(201);
    await saveWorkflow(cookie, await binderWorkflowWithEcho(cookie));

    const created = await readJson<CreateRunResponse>(
      await postJson(`${handle!.url}/api/workflows/${DRAFT_ID}/runs`, {}, cookie),
    );
    const detail = await waitForTerminal(handle!, cookie, created.run.id);

    expect(detail.run.status).toBe('failed');
    const echoTask = detail.tasks.find((task) => task.nodeId === 'node-echo')!;
    expect(echoTask.state).toBe('failed');
    expect(echoTask.exitCode).toBe(1);
    expect(echoTask.error).toContain('deterministic custom Node failure');
    expect(echoTask.failureKind).toBe('exit-code');

    const logs = await readJson<TaskLogsResponse>(
      await getJson(
        `${handle!.url}/api/runs/${created.run.id}/tasks/${echoTask.id}/logs`,
        cookie,
      ),
    );
    expect(logs.lines).toEqual(
      expect.arrayContaining([
        'custom run started',
        'error=deterministic custom Node failure',
        'state=failed',
      ]),
    );
  });

  it('submits an installed Node through Slurm using its declared container environment', async () => {
    const scheduler = new CompletingScheduler();
    handle = await bootTestServer({ executor: 'slurm', commandRunner: scheduler });
    const accepted = await login(handle.url, handle.credential);
    const cookie = sessionCookie(accepted)!;

    const source = writePackage(handle.projectRoot, 'echo');
    expect((await install(cookie, source)).status).toBe(201);
    await saveWorkflow(cookie, await binderWorkflowWithEcho(cookie));

    const created = await readJson<CreateRunResponse>(
      await postJson(`${handle.url}/api/workflows/${DRAFT_ID}/runs`, {}, cookie),
    );
    const detail = await waitForTerminal(handle, cookie, created.run.id);

    expect(detail.run.status).toBe('completed');
    expect(detail.tasks).toHaveLength(6);
    expect(detail.tasks.every((task) => task.state === 'completed')).toBe(true);

    const echoJob = [...scheduler.jobs.entries()].find(([, job]) =>
      job.script.includes("SFLOW_MANIFEST_ID='echo-node'"),
    );
    expect(echoJob).toBeDefined();
    const script = echoJob![1].script;
    expect(script).toContain("export SFLOW_MANIFEST_VERSION='1.0.0'");
    expect(script).toContain("export ECHO_MODE='deterministic'");
    expect(script).toContain('apptainer exec --containall');
    expect(script).toContain("'ghcr.io/sflow/examples/echo-node:1.0.0'");
    expect(script).toContain("'run-echo'");

    // Resources from the installed Manifest become scheduler constraints.
    expect(
      scheduler.calls
        .filter((call) => call.command === 'sbatch')
        .some(
          (call) =>
            call.args.includes('--cpus-per-task=1') &&
            call.args.includes('--mem=1024M') &&
            call.args.includes('--time=5'),
        ),
    ).toBe(true);
  });
});
