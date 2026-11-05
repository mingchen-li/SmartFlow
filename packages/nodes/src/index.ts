/**
 * Built-in Binder Nodes: production-shaped Manifests plus deterministic local
 * implementations (ticket #7). The Manifest is the scientific contract; `run`
 * fulfils it without model weights, network, or Slurm.
 */

export * from './manifests';
export * from './run';
