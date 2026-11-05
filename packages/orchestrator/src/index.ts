/**
 * Orchestrator and Compute Executor contracts (tickets #7, #9, #10, #12).
 *
 * The Orchestrator plans dependency-ordered Tasks from an immutable Run
 * snapshot and persists Task state, Artifacts, Metrics, Provenance, and events
 * through the OrchestratorStore seam. A ComputeExecutor owns submission and
 * monitoring of one atomic Node attempt; LocalExecutor implements that
 * contract deterministically in-process.
 */
export * from './contracts';
export * from './local-executor';
export * from './orchestrator';
