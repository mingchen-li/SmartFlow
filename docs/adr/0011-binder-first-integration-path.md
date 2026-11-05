# Binder design as the first integration path

SFlow's first end-to-end acceptance path is Binder design. The team first runs the complete path with test Nodes that follow the production contracts, then replaces those Nodes with real model implementations one at a time; the Workflow, Artifact, Run, and Result View boundaries remain the same.

## Consequences

- The Web workspace and Orchestrator can be validated before every scientific environment is installed.
- Model-specific integration failures stay localized to their Node packages.
- The first real example covers input structures, candidate generation, sequence design, structure prediction/scoring, and candidate comparison.
