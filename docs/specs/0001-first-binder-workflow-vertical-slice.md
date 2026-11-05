## Problem Statement

SFlow has a defined product direction and domain model, but the repository does not yet contain an executable path through the product. A protein designer needs to move from a Workflow draft to an inspectable Binder design result in one Web workspace, while the system keeps scientific execution independent from the browser and from any one scheduler or model implementation.

The first product slice must prove that an authenticated Project user can create and validate a Binder design Workflow, submit it through SFlow-owned execution semantics, survive browser closure or Server restart without losing submitted Slurm work, and inspect logs, output data, and Provenance in a Result View. The repository currently contains domain and architecture documentation but no application implementation or test harness.

The prototype also made the Web workspace interaction contract concrete. A protein designer needs a desktop-like surface that keeps Project files, Workflow editing, Node discovery, Run monitoring, Result View context, and Agent interaction visible in one browser viewport. The page must not become a document that requires vertical scrolling, and the user must be able to recover the same Workflow editing context after app-level maximize mode.

## Solution

Implement the first web-first Binder design vertical slice around one Web/API acceptance seam:

`Workflow draft -> validation -> Run -> Task execution -> logs and outputs -> Result View`

An authenticated Project user opens the Web workspace with `sflow start`, edits an autosaved Workflow draft, selects target files from the Project filesystem, configures a Binder design DAG, validates it, and starts a Run. Deterministic test Nodes first exercise the complete path through a local development Compute Executor; the same Node Manifest contracts can then be replaced one at a time by real Binder model Nodes submitted through Slurm.

The Run captures the exact Workflow draft, parameters, File References, Node Manifest versions, and environment requirements used at start time. The Orchestrator owns Workflow execution semantics and reconciles submitted work after a browser close or Server restart. The first Result View is centered on Run/Task logs and output files, with schema-validated Candidate, Metric, and Provenance data and registered Widgets where those outputs exist.

The Web workspace uses a fixed viewport with a global toolbar, vertical product navigation, a Project file explorer, a tabbed Workflow editor, a React Flow-style canvas, a Run monitor, and an Agent surface. The three primary panels can be resized or collapsed independently. The canvas supports an in-app maximize mode that hides navigation and the file explorer, turns the Agent into a draggable floating ball, preserves the canvas viewport and selection, and restores the previous panel geometry when the user exits. Node discovery is a categorized, searchable Node Library backed by Node Manifest metadata rather than an empty-node insertion action.

## User Stories

1. As a Project user, I want to authenticate to my Project Server, so that only an authorized person can use the Project workspace.
2. As a protein designer, I want to run `sflow start` from a Project directory, so that I can open the Web workspace without a separate platform account.
3. As a protein designer, I want the Web workspace to provide project files, Workflow editing, Run management, results, and Agent entry points in one place, so that I do not have to stitch together separate tools.
4. As a protein designer, I want my current Workflow edits to autosave as a draft, so that I do not lose work while experimenting.
5. As a protein designer, I want only the content I start as a Run to be fixed for that Run, so that later draft edits affect future Runs without changing an active or completed Run.
6. As a protein designer, I want to select an input file already stored in the Project filesystem, so that SFlow can use shared storage without copying the file into another managed store.
7. As a Project user, I want SFlow to record the filesystem location of each input File Reference, so that I can see which source file a Run used.
8. As a Project user, I want Project, Run, and Task directories to keep files in separate namespaces, so that two results with the same filename cannot overwrite one another.
9. As a protein designer, I want to add Nodes from their declared capabilities, so that I can see what each scientific step accepts and produces.
10. As a protein designer, I want to connect Nodes into a valid directed Workflow, so that execution order and data dependencies are visible.
11. As a protein designer, I want Node configuration forms to be generated from the Node Manifest, so that I can configure parameters without memorizing internal formats.
12. As an advanced user, I want to inspect or edit the underlying Node configuration, so that I can use detailed scientific options while still receiving validation.
13. As a protein designer, I want to configure resources for each Node, so that the Run records the CPU, memory, GPU, and other requirements needed by the step.
14. As a protein designer, I want invalid connections, missing inputs, invalid parameters, and impossible dependencies to be reported before execution, so that an invalid Workflow cannot start.
15. As a protein designer, I want validation messages to identify the affected Node or connection and explain the correction, so that I can repair a Workflow without reading implementation details.
16. As a protein designer, I want to start a Run only after validation succeeds, so that every Run has a well-defined execution snapshot.
17. As a protein designer, I want the Run snapshot to contain the Workflow, parameters, File References, Node Manifest versions, and environment requirements used at start time, so that the Run remains explainable.
18. As a protein designer, I want later edits to the draft to leave an active or completed Run unchanged, so that historical results remain understandable.
19. As a protein designer, I want each atomic Node attempt to appear as a Task with a clear state, so that I can tell whether it is queued, running, completed, failed, canceled, or awaiting a rerun.
20. As a Project operator, I want the Orchestrator to honor declared dependencies, so that a Task does not start before its inputs are ready.
21. As a Project operator, I want deterministic local execution for development and testing, so that the Web/API path can be verified without a live cluster or model weights.
22. As a Project operator, I want production Nodes to run in their declared container environment through a Compute Executor, so that scientific dependencies do not execute arbitrary host-process code inside the Server.
23. As a Project operator, I want one atomic Node execution to map to one Slurm Job, so that scheduler work remains visible and resource requirements remain attributable to the Node.
24. As a Project operator, I want scheduler-specific submission and monitoring hidden behind the Compute Executor, so that Workflow semantics stay independent of Slurm details.
25. As a protein designer, I want submitted Tasks to keep running when the browser closes, so that a browser session is not a prerequisite for scientific computation.
26. As a Project operator, I want the Server to reconnect to submitted Slurm Jobs after a restart, so that Run and Task state can be reconstructed instead of being lost from memory.
27. As a protein designer, I want to see Run and Task logs and progress in the Web workspace, so that I can diagnose a design without manually reconstructing scheduler state.
28. As a protein designer, I want to cancel a Run, so that queued work is canceled and running Slurm work is asked to stop while completed Tasks remain unchanged.
29. As a protein designer, I want each Node to declare whether and how often it may be retried, so that transient failures can recover without endlessly repeating parameter errors.
30. As a protein designer, I want a failed Task's history retained when I rerun it, so that recovery does not rewrite the original failure record.
31. As a protein designer, I want generated Node outputs to be recorded as managed Artifacts, so that a result referenced by a Run cannot silently change.
32. As a protein designer, I want the Binder design path to produce candidate sequences and any declared CandidateSet context, so that individual candidates and their generation or comparison context remain distinguishable.
33. As a protein designer, I want each Metric to carry its meaning, unit or scale where applicable, and Provenance, so that I can interpret candidate quality without guessing what a number represents.
34. As a protein designer, I want the default Result View to show Run and Task logs and output files, so that I can inspect what happened even when a specialized visualization is unavailable.
35. As a protein designer, I want compatible Candidate, Metric, Artifact, and Provenance data to appear alongside the logs, so that I can evaluate a result and explain how it was produced.
36. As a protein designer, I want Result View Widgets to declare which data they understand, so that incompatible scientific values cannot be silently mixed.
37. As a protein designer, I want unknown outputs to fall back to a safe generic view, so that a new Node does not make the entire Result View unusable.
38. As a protein designer, I want to download generated files independently of the Web presentation, so that an output can be used in another tool or Workflow.
39. As a Node author, I want a deterministic test Node to implement the same ports, parameters, outputs, Metrics, resource requirements, and environment contract as a production Node, so that the control plane can be verified before a scientific environment is installed.
40. As a Node author, I want to replace a test Node with a real Binder model implementation without changing the Workflow IR or Result View IR, so that model-specific integration failures stay inside the Node package.
41. As a Project user, I want to install a custom Node from the Project itself, so that I can extend SFlow without waiting for a public Node marketplace.
42. As a Project user, I want the integrated terminal to remain available after authentication, so that I can inspect files, debug tools, or run direct commands using the deployment's permissions.
43. As a Project user, I want to understand that direct terminal work is outside the Run/Task/Provenance history, so that I do not mistake an untracked command for a reproducible Workflow Run.
44. As a maintainer, I want the first complete path to run with test Nodes and then real Binder Nodes one at a time, so that the Web workspace and execution contracts are validated before every scientific environment is installed.
45. As a maintainer, I want the Workflow IR and Node Manifest contracts to leave room for bounded Loops, sub-workflows, and future Agent patches, so that the first vertical slice does not lock the platform out of its planned capabilities.


46. As a protein designer, I want the Web workspace to fill the browser viewport without page-level scrolling, so that the Workflow and Run controls remain reachable at every window height.
47. As a protein designer, I want a global toolbar to show the Project name, current state, save action, and Run action, so that I can understand and control the current Project from any workspace section.
48. As a protein designer, I want navigation for Project files, Workflows, Node Library, Terminal, and Runs, so that the major Project capabilities have stable entry points.
49. As a protein designer, I want the file explorer and chat history to scroll independently, so that reading one surface does not move the canvas or the rest of the workspace.
50. As a protein designer, I want Workflow files to open as tabs with a dedicated Workflow toolbar, so that editing actions remain close to the active Workflow.
51. As a protein designer, I want to see Nodes, ports, edges, selection, zoom, and viewport position on a Workflow canvas, so that the Workflow IR is understandable while I edit it.
52. As a protein designer, I want to insert a Node by browsing or searching the categorized Node Library, so that a large catalog remains findable and every inserted Node starts from a declared Node Manifest.
53. As a protein designer, I want to insert duplicate instances of the same Node, so that repeated computation is possible without inventing a second Node type.
54. As a protein designer, I want an execution monitor to show progress, Task/Slurm state, resource usage, logs, and a result preview, so that I can follow a Run from the same workspace.
55. As a protein designer, I want to switch between a Workflow Agent and a Node Agent, so that an Agent's context matches the level of change I am discussing.
56. As a protein designer, I want selecting a Node to switch the Agent to that Node's context automatically, so that the Agent can explain and edit the selected Node without manual re-selection.
57. As a protein designer, I want Node context, conversation history, parameter editing, and a fixed message composer in one Agent surface, so that I can inspect and propose changes without losing the Workflow context.
58. As a protein designer, I want the three primary panels to resize and collapse, so that I can give space to the task I am doing while keeping the main operation usable.
59. As a protein designer, I want to maximize the Workflow canvas inside the app, so that I can focus on graph editing while retaining the global and Workflow toolbars.
60. As a protein designer, I want maximize mode to preserve Node positions, edges, selected Node, zoom, viewport, panel proportions, and expansion state, so that changing view mode does not reset my editing context.
61. As a protein designer, I want the maximized Agent to appear as a draggable floating ball that expands into a draggable and resizable panel, so that the Agent remains available without permanently covering the canvas.
62. As a protein designer, I want the workspace to shrink flexible regions first and collapse secondary panels at narrow widths, so that the canvas and Run controls remain usable on small browser windows.
63. As a Project user, I want the UI to follow the Matwings Venus Light design tokens, so that buttons, inputs, Tabs, Cards, Badges, Sidebar items, states, spacing, and focus rings have a consistent visual language.
64. As a Project user, I want the workspace to use the `SFlow` text brand, English UI copy, and no user avatars or invented logo assets, so that the product surface stays aligned with the approved visual system.
65. As a protein designer, I want each canvas Node that belongs to the active Run to show its current Run/Task state while the Run is active, so that I can follow execution without leaving the graph.

## Implementation Decisions

- The implementation is the first Binder design vertical slice, centered on the Web/API acceptance seam from draft creation through Result View inspection.
- The Web workspace is the primary interactive surface. The `sflow` command starts or manages the Project Server; the initial product does not provide a parallel CLI for Workflow editing, execution management, Agent interaction, or Result View analysis.
- SFlow is a project-scoped, single-user Server with one Project login credential. Local and remote access both require login; deployment owners control the authenticated user's terminal and filesystem permissions.
- The current Workflow draft autosaves. Starting a Run captures an immutable snapshot of the Workflow, parameters, File References, Node Manifest versions, and environment requirements. A separate user-facing Workflow history is not required for this slice.
- Workflow IR is the canonical protocol shared by the Web client, Server, Orchestrator, Compute Executor, and future Agent or CLI integrations. Canvas layout and runtime state are kept separate from execution semantics.
- A draft must pass schema and semantic validation before Run creation. Validation covers ports, required inputs, parameter schemas, dependency validity, resource declarations, and the Binder path's required outputs.
- The first acceptance path is a DAG of deterministic contract-compliant test Nodes for target input, candidate generation, sequence design, structure prediction or scoring, and candidate comparison. Real model Nodes replace the test Nodes incrementally without changing the surrounding protocols.
- Each Node Manifest declares ports, parameter schema, scientific outputs, Metrics, resource requirements, environment contract, and retry policy. Production Nodes run in an OCI-compatible container through the Compute Executor.
- One atomic Node execution maps to one Slurm Job in production. Fan-out, fan-in, and future Job Array planning remain Orchestrator concerns.
- The Orchestrator owns dependency planning, Run/Task state, cancellation, retry decisions, restart reconciliation, caching semantics, and Provenance. The Compute Executor owns scheduler submission, status monitoring, cancellation requests, and log collection.
- Submitted Slurm work continues after browser closure or Server restart. The Orchestrator reconstructs active state from persisted Project state and scheduler state; legacy jobs that were not created by SFlow are outside this slice.
- Canceling a Run cancels queued work and asks running Slurm Jobs to stop. Completed Tasks and their scientific records remain unchanged. A failed Task is rerun through a new attempt while its failed history remains visible.
- User-provided inputs are written directly to the Project filesystem and represented as path-only File References. SFlow does not copy or hash those bytes during upload, does not detect later replacement of a path, and does not promise cache invalidation for path-backed inputs in this slice.
- Project, Run, and Task namespaces prevent same-named files from overwriting one another. Managed Node outputs remain immutable Artifacts and may use stronger content identity than user-provided File References.
- Candidate, CandidateSet, Metric, and Provenance are typed domain data. Metric schemas remain namespaced and versioned; different meanings are never implicitly merged.
- Result View IR is the durable description of the analysis page. The initial Result View is log- and output-centered, then adds only schema-compatible Candidate, Metric, Provenance, and registered Widget data.
- Widgets declare the Artifact and Metric schemas they accept and the interactions they support. Results Agents or future extensions compose registered Widgets; arbitrary frontend code generation is not part of this slice.
- The first start of a Project creates or requests its single Project login credential, and the credential can be rotated from Project settings.
- Custom Nodes are initially installed at Project scope. A public marketplace and broad distribution workflow are future extensions.
- The integrated terminal is an authenticated escape hatch. It may run direct commands, including scientific programs and scheduler commands, under deployment permissions; those commands are intentionally outside Run/Task/Provenance tracking.
- SFlow does not adopt Nextflow or another scheduler DSL as the public Workflow protocol. Scheduler implementation details remain behind Compute Executor interfaces.


- The Web workspace is a fixed-viewport control surface. Its UI layout state is separate from Workflow IR and includes panel widths, collapsed states, fullscreen mode, Agent presentation mode and geometry, Node Library query/category, canvas viewport, and current selection.
- The primary shell contains the global toolbar, Project navigation, file explorer, file tabs, Workflow toolbar, canvas, Run monitor, and Agent surface. Each scrollable surface owns its own overflow container; the document body remains non-scrolling.
- The three-panel shell exposes user-controlled resizing and collapse. Responsive behavior reduces flexible space first, collapses the file explorer before the main editor, and collapses the Agent surface only when the viewport cannot preserve the main operation.
- At narrow widths, monitor cards stack or scroll rather than disappearing. Secondary panel collapse is allowed; dropping Run, Task, resource, log, or result data is not.
- Maximize mode is app-level state, not browser fullscreen. It keeps the global toolbar and Workflow toolbar, hides the navigation and file explorer, expands the canvas, and presents the Agent as a floating ball or floating panel. Entering and leaving the mode must not mutate Workflow IR.
- The Agent floating presentation uses the Workflow Agent and Node Agent contexts from ADR-0005. Selecting a Node changes the active Agent context; mutations still pass through typed patches, schema validation, semantic checks, preview/diff, explicit application, and rollback.
- The Node Library is a searchable catalog derived from Node Manifest metadata. Categories are navigational filters, search matches name, description, and type, and insertion creates a configured Node instance. An empty placeholder Node is not a valid insertion path.
- The reference layout is Variant A (Workbench), a balanced three-panel IDE. Variants B (Focus Graph) and C (Control Room) were exploration only; the production workspace does not expose a variant switcher.
- The workspace uses `SFlow` as its text brand and English UI copy. The prototype's `SUPERFLOW` label and Chinese navigation labels are placeholders, not product copy.
- While a Run is active, canvas Nodes that belong to that Run show read-only Run and Task state. The overlay is derived from Run state and never becomes part of Workflow IR, the draft, or layout state.
- The reference prototype uses the Matwings Venus Light tokens: primary `#3572FF`, primary hover `#5990FF`, active `#2150D2`, primary background `#F5F9FF`, primary border `#A0C6FF`, text `#242428`, secondary text `#8A8A97`, surfaces `#FFFFFF`/`#FAFAFB`/`#F6F6F7`, border `#E8E8EC`, success `#12B76A`, warning `#F59E0B`, and destructive `#E7000B`. Production UI components should use the shared token source rather than duplicating values.
- The prototype's current UI state is in-memory. Production persistence is limited to the Project, Workflow draft, Run, Task, Result View, and Agent patch contracts already defined by the surrounding tickets.

## Testing Decisions

- The primary test is one external-behavior Web/API acceptance scenario that authenticates to a Project, creates an autosaved Binder Workflow draft, registers path-backed target inputs, validates the draft, starts a Run, waits for deterministic test Nodes, and inspects logs, output Artifacts, Metrics, Provenance, and the Result View.
- Tests assert external protocol behavior and user-visible outcomes: validation diagnostics, immutable Run snapshots, dependency-respecting Task transitions, browser-close and Server-restart reconciliation, cancellation, manifest-controlled retry, retained failed history, Artifact immutability, schema-safe Result View bindings, and downloadable output.
- Tests do not assert private Orchestrator methods, database tables, component internals, scheduler command construction, or frontend implementation details. A change is acceptable when the external Workflow, Run, Task, Artifact, Metric, Provenance, and Result View contracts remain true.
- The acceptance harness uses a deterministic local Compute Executor and deterministic test Node Manifests, so it does not depend on model weights, Slurm availability, or scientific score variance.
- Node contract tests verify ports, parameter validation, outputs, Metrics, resource requirements, environment declaration, and retry policy.
- Orchestrator/Compute Executor contract tests cover dependency ordering, one Task per atomic Node attempt, Slurm state mapping, cancellation requests, restart reconciliation, and explicit rerun history.
- Workflow and Run boundary tests cover autosaved drafts, pre-run validation, immutable snapshots, later draft edits, File Reference path visibility, and namespace isolation for same-named files.
- Artifact and Result View tests cover typed Candidate/CandidateSet/Metric data, Provenance links, log-centered rendering, compatible Widget bindings, and safe generic rendering for unknown outputs.
- There is no existing application test suite in the repository, so this issue establishes the first acceptance and contract-test prior art.


- Browser acceptance tests use the highest Web workspace seam available: authenticate a Project user, open the fixed viewport, select a file, open the Node Library, search and insert a Node, select the Node to activate Node Agent, edit parameters, validate, start a Run, inspect the monitor and Result View, and switch maximize mode.
- Layout tests assert external behavior rather than CSS implementation: no document scrollbar, independent explorer/chat/monitor scrolling, panel resize and collapse, narrow-window fallback, and stable primary controls.
- Maximize tests assert that Node positions, edges, selection, zoom, viewport, panel sizes, and expansion state are unchanged across enter/exit. They also assert that the floating Agent ball can be moved, expanded, resized, and collapsed without changing Workflow IR.
- Canvas status tests assert that an active Run's Task state appears on the corresponding Node without mutating Workflow IR, draft content, Node positions, or selection.
- Node Library tests assert category counts, query matching across Node name/description/type, empty search state, insertion from a selected Node Manifest, duplicate instances, and Node Agent activation.
- Design-system checks assert token-driven states for Button, Input, Tabs, Sidebar Item, Card, Badge, Progress, focus rings, and semantic status colors, plus the `SFlow` text brand, English UI copy, and the absence of avatars or invented logo assets.
- Existing Web/API acceptance and contract tests remain authoritative for Workflow IR, Run, Task, Artifact, Metric, Provenance, Result View IR, and Compute Executor behavior.

## Out of Scope

- Multi-user collaboration, user and role management, organization tenancy, billing, and cross-Project sharing.
- A parallel CLI interface for Workflow editing, execution management, Agent interaction, or Result View analysis.
- Automatic detection that a path-backed File Reference was replaced, content hashing for uploaded files, or cache invalidation based on path changes.
- Automatic takeover of legacy Slurm Jobs that were not submitted by SFlow.
- Arbitrary host-process execution for production Nodes or a separate user-script sandbox inside the Server. Direct terminal commands remain an explicit authenticated escape hatch.
- A public Nextflow or other scheduler DSL as SFlow's Workflow protocol.
- Full multi-round Loop optimization, recursive Workflow composition, and large-scale Job Array optimization in the first Binder acceptance path; the protocol must leave room for them.
- Full Workflow, Node, and Results Agent implementation and natural-language patch generation in the first vertical slice; the protocol and validation seams must not block them.
- A public Node marketplace or cross-Project Node distribution service.
- Scientific validation of Binder quality, template fit, model accuracy, training, or cluster resource benchmarking. Those are separate Node-level research and integration concerns.
- Installing and distributing every real Binder model and its weights. The first slice may use deterministic test Nodes and replaceable model contracts.
- A final database technology decision beyond the persistence behavior required by the domain contracts.
- A complete Project migration package, high-availability control plane, or cloud object-storage service.


- A browser-native fullscreen API, a separate desktop client, or a second CLI control surface.
- Persisting panel geometry, Agent ball position, Node Library search text, or canvas viewport across Project sessions unless a later product decision adds those preferences.
- A public Node marketplace, unrestricted frontend code generation, and arbitrary Node insertion without a validated Node Manifest.
- A dark theme or a second design-token mode in the first UI implementation; the attached Matwings Venus specification currently defines the Light mode used here.
- Prototype-only affordances: the A/B/C layout switcher, undo/redo and auto-layout buttons, minimap and coordinate readout, and keyboard layout switching.
- A general-purpose file viewer or editor for arbitrary Project files; workspace tabs are limited to Workflow-related files.

## Further Notes

- The repository currently contains architecture and domain documentation but no executable application, dependencies, model assets, or scheduler jobs. Implementation should land in small vertical increments while preserving the acceptance seam.
- The first real model integration should replace one deterministic test Node at a time. Workflow IR, Node Manifest, Artifact, Run, and Result View boundaries should not be redesigned around a model-specific implementation.
- The initial Result View interpretation follows the latest product direction: logs and produced files are the baseline result surface; richer scientific widgets appear only when their schemas are declared and validated.
- VHH-specific model choices, real model weights, and cluster resource requirements remain open implementation or research details. They should be captured in follow-up issues once the contract-level slice is running.


- The prototype-derived decisions were validated in `codex/prototype-binder-agent` through commit `476648d`; the prototype remains throwaway reference material, while this spec records the decisions that should survive a production rewrite.
- The browser acceptance seam should keep the UI state boundary explicit so a future CLI or Agent integration can consume Workflow IR and Result View IR without depending on canvas layout.
- Some decisions in this spec intentionally correct or exceed the prototype: the `SFlow` brand and English UI copy replace the prototype's placeholders, monitor cards stack or scroll instead of disappearing at narrow widths, and maximize mode restores the pre-maximize panel state. These are production requirements, not prototype-validated behavior.
