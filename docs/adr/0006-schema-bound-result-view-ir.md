# Schema-bound Result View IR

Result View IR is the only durable description of result analysis pages. Widgets must declare the Artifact and Metric schemas they accept, data bindings are validated before rendering, and unknown outputs fall back to safe generic views. Results Agents select and compose registered Widgets rather than generating arbitrary React code; third-party Widgets extend the registry through the same schema and interaction contract.

## Consequences

- Result pages can adapt to different protein-design workflows without making the frontend an untyped code-generation target.
- Scientific metrics cannot be silently mixed when their schemas or meanings differ.
- The Widget registry becomes an extension point with an explicit compatibility contract.
