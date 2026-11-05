# SFlow owns Workflow execution semantics

SFlow's Workflow IR is the source of truth for DAGs, bounded Loops, Run/Task/Iteration state, retries, recovery, caching, and provenance. The TypeScript Orchestrator interprets that IR, while a Compute Executor submits and monitors jobs; SFlow does not adopt Nextflow or make a Nextflow DSL part of its public protocol because the platform needs first-class Agent edits, bounded iterative design, and result-oriented provenance.

## Consequences

- The Orchestrator and its protocol contracts are core SFlow product code.
- Slurm is an execution backend, not the owner of scientific workflow semantics.
- A future executor may target another scheduler without changing Workflow IR.
- Canceling a Run cancels queued work and attempts to stop running Slurm Jobs; completed Tasks remain unchanged and the Run records a canceled state.
