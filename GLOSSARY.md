# SFlow

SFlow is a project-scoped protein design workspace. Its domain language describes how a scientific workflow is defined, executed, and analyzed, independently of any particular user interface or compute backend.

## Project and execution

**Project**:
A self-contained workspace for a protein design effort, including workflow definitions, executions, scientific data, and saved result views.
_Avoid_: Workspace, tenant

**Workflow**:
A versioned specification of a protein design computation, including its steps, data flow, control flow, and scientific intent.
_Avoid_: Pipeline, canvas

**Workflow IR**:
The canonical protocol that represents a Workflow's execution semantics and can be consumed by the web client, CLI, Agent, and Orchestrator.
_Avoid_: React Flow graph, UI state

**Workflow Version**:
An immutable revision of a Workflow that can be used as the basis for a Run.
_Avoid_: Draft, latest workflow

**Run**:
One execution instance of a specific Workflow Version with fixed inputs, parameters, environment, and provenance.
_Avoid_: Job, session

**Task**:
One scheduled execution attempt of an atomic Node within a Run. Each attempt has its own identity, logs, and outcome; a retry or explicit rerun creates a new Task while earlier attempts remain inspectable history.
_Avoid_: Step, process

**Retry**:
A new Task attempt the Orchestrator schedules automatically after a retryable failure, according to the Node Manifest's immutable RetryPolicy. Parameter and validation errors are never retried.
_Avoid_: Loop iteration, rerun

**Rerun**:
An explicit user request to execute a failed or canceled Task again as a new attempt, reusing completed upstream work and replanning downstream work as needed.
_Avoid_: Retry, restart

**Cancellation**:
Ending a Run without rewriting completed Tasks or their scientific records; queued work stops before starting and running executor jobs are asked to stop.
_Avoid_: Abort, rollback

**Iteration**:
One cycle of a Loop, with its own inputs, outputs, metrics, and termination state.
_Avoid_: Round, retry

**Loop**:
A first-class Workflow control structure that repeats a sub-workflow while transferring declared state under explicit termination, iteration, and resource limits.
_Avoid_: Retry, infinite loop

## Nodes and scientific data

**Node**:
An atomic computational operation in a Workflow that consumes declared inputs and produces declared outputs.
_Avoid_: Plugin, step implementation

**Node Manifest**:
The declaration of a Node's ports, parameter schema, scientific outputs, execution requirements, and environment contract.
_Avoid_: Node config, container recipe

**Artifact**:
A named piece of scientific data used as an input or produced as an output of a Run. A managed Artifact is immutable and addressable; a user-provided file may remain a path reference owned by the Project filesystem.
_Avoid_: Attachment

**File Reference**:
A Project record that points to a user-provided file by its filesystem location without copying or hashing the file contents.
_Avoid_: Managed Artifact, Upload blob

**Candidate**:
One protein sequence, structure, or related design item evaluated by a Workflow.
_Avoid_: Sample, result file

**CandidateSet**:
A named collection of Candidates that share a generation, filtering, comparison, or selection context.
_Avoid_: Batch, dataset

**Metric**:
A typed scientific measurement with an explicit meaning, unit or scale where applicable, and provenance linking it to the data and computation that produced it.
_Avoid_: Score, value

**Provenance**:
The record of the inputs, parameters, models, environments, and execution events that explain how an Artifact or Metric was produced.
_Avoid_: Log, metadata

## Analysis and interaction

**Result View**:
A saved scientific presentation and analysis of Workflow outputs, including data bindings, layout, filtering, and interactions.
_Avoid_: Dashboard, report

**Result View IR**:
The schema-bound protocol that describes a Result View independently of its rendered frontend components.
_Avoid_: React page, dashboard JSON

**Widget**:
A registered visualization or analysis component that declares the Artifact and Metric schemas it can consume and the interactions it supports.
_Avoid_: Arbitrary component, chart

**Agent**:
An AI interaction actor with a defined context, tools, and mutation scope for working with Workflows, Nodes, Runs, or Result Views.
_Avoid_: Copilot, autonomous worker

