# First-slice implementation architecture

Binding technical decisions for the tickets under issue #1. The spec
(`docs/specs/0001-first-binder-workflow-vertical-slice.md`) is the product
contract; this document only pins the implementation choices so independent
tickets produce one coherent system. If the two disagree, the spec wins and the
implementer should report the conflict.

## Stack

- TypeScript everywhere; Node 22+ (the repo runs Node 26).
- pnpm workspaces. The lockfile is committed.
- Server: Fastify 5 with `@fastify/cookie`, `@fastify/static`, `@fastify/websocket`.
- Schema validation: Zod.
- Persistence: SQLite through Node's built-in `node:sqlite` (`DatabaseSync`). No ORM.
- Web: React + Vite + `@xyflow/react` + Zustand. Plain CSS with Matwings tokens.
- Tests: Vitest for unit/integration; Playwright for browser acceptance
  (Chromium is already cached on this machine).
- Terminal: WebSocket plus `child_process` shell; `@xterm/xterm` on the client.
  Do not add `node-pty`.
- Hashing: `node:crypto` SHA-256 for managed Artifacts.
- IDs: `crypto.randomUUID()`.

## Workspace layout

```
apps/server        @sflow/server        Fastify app, auth, store, routes, terminal
apps/web           @sflow/web           React workspace
apps/cli           @sflow/cli           `sflow` command
packages/domain    @sflow/domain        Zod schemas and shared types
packages/orchestrator @sflow/orchestrator  Orchestrator + ComputeExecutor
packages/nodes     @sflow/nodes         Built-in deterministic Binder Nodes
packages/nodes-structure-prediction
                   @sflow/nodes-structure-prediction
                                        Production structure-prediction@2.0.0
                                        replacement seam (devDependency of
                                        apps/server for its tests)
packages/test-support @sflow/test-support  In-memory store, fake executor, fixtures
tests/acceptance   Playwright specs
```

Keep dependencies pointing inward: domain has no dependencies on apps; the
orchestrator depends on domain; the server wires orchestrator, nodes, and store.

## Project state

- The Project root is the directory passed to `sflow start` (default: cwd).
- SFlow state lives in `<project>/.sflow/` and is git-ignored.
- `sflow.db` is the SQLite database; `runs/<runId>/tasks/<taskId>/` holds logs
  and outputs; `executor/` holds executor job state; `nodes/` holds installed
  custom Nodes.
- The file explorer exposes the Project tree but hides `.sflow/`.

Tables (minimum): `settings`, `workflows`, `runs`, `tasks`, `artifacts`,
`metrics`, `result_views`, `agent_patches`, `installed_nodes`, `events`.
Run snapshots and Result View IR are stored as JSON validated by Zod.

## Authentication

- One Project credential. Store a scrypt hash plus salt in `settings`; store a
  random session secret in `settings` too.
- First start generates a credential and prints it once. `--credential <value>`
  and `SFLOW_CREDENTIAL` set a deterministic credential for tests and automation.
- `POST /api/auth/login` sets an HttpOnly, SameSite=Lax, HMAC-signed
  `sflow_session` cookie. Sessions survive a Server restart because the secret is
  persisted.
- Every `/api/*` and websocket route requires authentication except
  `/api/health` and `/api/auth/login`. `/login` is public; `/` redirects there.
- `POST /api/auth/rotate` replaces the credential after re-authentication.

## API surface (extend as tickets need)

- `GET /api/health`
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`,
  `POST /api/auth/rotate`
- `GET /api/project`
- `GET /api/files?path=...`, `POST /api/files` (register a path or write a file)
- `GET/PUT /api/workflows/:id` (draft + layout), `POST /api/workflows/:id/validate`
- `POST /api/workflows/:id/runs`
- `GET /api/runs`, `GET /api/runs/:id`, `POST /api/runs/:id/cancel`,
  `POST /api/runs/:id/tasks/:taskId/rerun`
- `GET /api/runs/:id/events` (SSE or polling), `GET /api/runs/:id/tasks/:taskId/logs`
- `GET /api/runs/:id/result-view`
- `GET /api/runs/:id/artifacts/:artifactId/download`
- `POST /api/workflows/:id/agent/patches`, `POST /api/agent/patches/:id/apply`,
  `POST /api/agent/patches/:id/revert`, `GET /api/agent/patches/:id`
- `GET /api/nodes`, `GET /api/nodes/:id`, `POST /api/nodes/install`,
  `DELETE /api/nodes/:id`
- `WS /api/terminal`

Use JSON bodies, `{ error: { code, message, details? } }` for failures, and
stable resource shapes from `@sflow/domain`.

## Domain contracts

All schemas live in `packages/domain` and are exported with inferred types.

- `WorkflowIR`: version, id, name, nodes, edges. Node instances reference a
  Manifest id/version and carry parameters and resource overrides. Canvas layout
  is a separate `EditorLayout` object and is never part of Workflow IR.
- `NodeManifest`: id, version, name, description, category, inputs/outputs,
  parameter specs, metric specs, resources, environment, retry policy.
  Parameter specs drive generated forms and validation.
- `RunSnapshot`: Workflow IR, parameters, File References, Manifest versions, and
  environment requirements captured at start time.
- `Candidate`, `CandidateSet`, `Metric`, `Provenance`, `Artifact`.
- `ResultViewIR`: version, run id, widget blocks, schema-bound bindings.
- `AgentPatch`: scope, target, base version, JSON Patch operations, status.
- `EditorLayout`: node positions, viewport, and selection only. Panel geometry,
  maximize mode, Agent presentation (panel width, collapsed/floating state,
  floating position and size), and the Node Library query are UI-only state:
  they are never persisted with the draft and never enter Run snapshots.

## Orchestrator and executors

- `Orchestrator` owns dependency planning, Task state, cancellation, retry
  policy, restart reconciliation, Provenance, and event persistence.
- `ComputeExecutor` contract:
  `submit(taskSpec) -> { jobId }`, `poll(jobId) -> { state, exitCode?, logs? }`,
  `cancel(jobId)`, `reconcile(runId)`.
- `LocalExecutor` runs deterministic Nodes in-process, writes logs/outputs under
  the Task directory, persists job state so a Server restart can reconcile, and
  supports cancellation through an AbortSignal.
- `SlurmExecutor` builds `sbatch`/`squeue`/`sacct`/`scancel` commands behind an
  injected `CommandRunner`. Contract tests use a fake runner; no real Slurm is
  required.
- The Server calls `orchestrator.reconcileAll()` on startup.
- Restart reconciliation is deterministic. A Task whose executor job completed
  while the Server was down is adopted without re-execution. A Task attempt that
  was `running` when the process died (or was queued with a persisted executor
  job) is closed as `failed` with exit code 137 and the message "The Server
  restarted while this Task attempt was running.", and a new attempt is queued
  for the same Node. Completed Tasks are never re-run or rewritten, and queued
  Tasks with no executor job resume in place. Reconciliation is idempotent.
- Server shutdown stops monitoring without canceling executor work or writing
  terminal Run/Task state, so the next process reconciles from persisted Project
  and executor records.
- Task state vocabulary: `queued`, `running`, `completed`, `failed`, `canceled`.
  A rerun creates a new attempt; prior attempts stay visible.
- Logs are line-oriented files. Events are append-only DB rows for state changes.

## Built-in Nodes

`packages/nodes` ships deterministic, production-shaped Binder Nodes:

1. target input
2. candidate generation
3. sequence design
4. structure prediction/scoring
5. candidate comparison

Each exports a Manifest and a `run(input, params, context)` function. Outputs are
deterministic for a given seed. No model weights, network, or Slurm are needed.
Custom Nodes are trusted Project code: a directory with `manifest.json` and
`index.mjs` exporting `run`; validate the Manifest before installation. Production
execution uses the Manifest's container environment; local execution imports the
module in-process.

`packages/nodes-structure-prediction` is a separate production replacement for
the structure-prediction Node. It depends on `@sflow/domain` for shared
scientific schema identities but deliberately does not depend on
`packages/nodes`; model-specific helpers stay duplicated so the production
implementation and the deterministic fixtures can evolve independently.

## Web workspace

- One fixed-viewport shell: global toolbar, vertical nav, file explorer, tabbed
  editor, React Flow canvas, Run monitor, Agent panel. `html`, `body`, and the app
  root never scroll; every scrolling surface owns its overflow.
- Editor layout state is separate from Workflow IR and Run snapshots.
- Use the Matwings Venus Light tokens from `docs/design-system/matwings-venus.md`.
  Put the token variables in one CSS file; do not duplicate hex values in
  components.
- Brand text is `SFlow`; UI copy is English.
- Node Library is a modal with categories, counts, search over name/description/
  type, an empty state, and insertion of configured Nodes. No empty placeholder
  Nodes.
- Maximize mode is app-level; it preserves Node positions, edges, selection,
  zoom, viewport, panel proportions, and expansion state, and presents the Agent
  as a draggable floating ball/panel.
- Run monitor tabs: Overview, Tasks/Slurm, Resources, Logs, Results. At narrow
  widths cards stack or scroll; never drop data.
- Canvas Nodes belonging to an active Run may show read-only Run/Task state; the
  overlay never mutates Workflow IR, draft, or layout.
- Result View uses a Widget registry that declares accepted schemas; unknown
  outputs fall back to a generic view.
- Agent mutations use typed JSON Patches: validate, semantic-check, diff, apply,
  revert. The Agent surface is functional without an external LLM; the validated
  patch boundary is the product requirement.

## Commands and tests

Root scripts (all must work from a clean checkout):

- `pnpm install`
- `pnpm typecheck`
- `pnpm test` (Vitest unit + integration)
- `pnpm test:e2e` (Playwright)
- `pnpm build`
- `pnpm sflow start --project <dir> --port <port> --no-open [--credential <pwd>]`

Integration tests boot the real Fastify app on an ephemeral port with a temp
Project directory. Browser tests use the cached Playwright Chromium. Prefer
external behavior (HTTP, DOM, files) over private methods. No test may depend on
model weights, Slurm, or network access.

## Ticket workflow

Each implementer works in its own worktree and branch:

1. Verify the worktree is based on `integration/0001-first-binder-workflow`;
   reset onto it if not.
2. Create `ticket/<NN>-<slug>`.
3. Read the ticket (`gh issue view <NN>`), the spec, relevant ADRs, and this note.
4. Call the `tdd` skill and build test-first.
5. Run `pnpm typecheck` and the relevant tests; leave the branch green.
6. Merge the current integration tip into the ticket branch before reporting.
7. Commit with a conventional message. Do not push. Do not close or comment on
   issues; the orchestrator resolves them.

Report: branch, commit SHA, tests run, acceptance criteria status, and any
deviation or follow-up. Keep the report short.
