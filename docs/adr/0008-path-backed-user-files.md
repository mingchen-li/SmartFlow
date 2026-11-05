# Path-backed user files

User-uploaded files are written directly to the Project filesystem. SFlow records their filesystem locations and uses those references as Workflow inputs; it does not copy the bytes into a separate managed store or calculate a content hash as part of upload. Project, Run, and Task directories provide the namespace that prevents same-named files from overwriting one another. Detecting later replacement of a path-backed file and invalidating cached work for it are outside the initial product scope.

## Consequences

- The UI and Run snapshot must show the path used by each input.
- Reproducibility of path-backed inputs depends on the deployment and user keeping the recorded path stable.
- Managed outputs can still use the stronger immutable Artifact rules when a Node produces them.
