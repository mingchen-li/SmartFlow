# Autosaved drafts and immutable Run snapshots

The Web workspace autosaves the user's current Workflow edits as a draft. When the user starts a Run, SFlow captures the exact Workflow, parameters, and inputs used for that Run; later edits affect only future Runs and never rewrite an active or completed Run.

## Consequences

- Users do not need a separate version-history interface to avoid losing work.
- Every Run remains explainable even though the editor keeps only the current draft visible.
- A draft must pass the normal validation checks before it can start a Run.
