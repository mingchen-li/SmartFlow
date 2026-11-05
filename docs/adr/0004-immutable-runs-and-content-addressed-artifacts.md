# Immutable Runs and content-addressed Artifacts

Each Run keeps an immutable snapshot of the workflow and parameters used to start it; the product does not need a user-facing workflow history. Managed Node outputs are immutable scientific records and may be content-addressed, while a user-uploaded input is recorded as a File Reference containing only its filesystem location. Project state stores schemas, references, and Provenance. Detecting later replacement of a path-backed file and invalidating cached work for it are outside the initial product scope.

## Consequences

- Resume and retry create auditable state transitions without rewriting completed scientific records.
- Cache behavior for path-backed inputs is not a product guarantee in the initial release.
- User uploads remain visible to Workflows without requiring SFlow to copy or hash their contents.
