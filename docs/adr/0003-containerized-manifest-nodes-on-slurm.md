# Containerized Manifest Nodes on Slurm

Production Nodes are defined by a Node Manifest and run in an OCI container submitted through the Compute Executor. One atomic Node maps to one Slurm Job; fan-out and Job Array planning remain Orchestrator concerns. The same Manifest contract may be used by a local development executor, but production Nodes do not execute arbitrary host-process code inside the Server.

## Consequences

- Node packages carry a reproducible environment and a typed scientific contract.
- Scheduler-specific details stay behind Compute Executor implementations.
- Node authors must declare ports, parameters, outputs, metrics, and resource requirements.
