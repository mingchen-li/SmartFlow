# Web-first Project control surface

The `sflow` command initially starts or manages the project Server and opens the Web workspace; workflow editing, execution management, Agent interaction, and result analysis are Web capabilities rather than a parallel CLI application. The Workflow IR remains a shared protocol so a future CLI can be added without changing scientific semantics.

## Consequences

- The first release has one primary interactive product surface to design and validate.
- Command-line startup remains useful for local and Slurm service-node deployment without duplicating Web behavior.
- Scripts and automation can still call the Server API later without making the initial CLI a second user interface.
