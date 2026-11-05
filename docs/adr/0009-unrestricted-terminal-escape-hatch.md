# Unrestricted terminal escape hatch

After authenticating to a Project, users may run commands directly in the integrated terminal, including scientific programs and scheduler commands. These actions are intentionally outside SFlow's Run/Task/Provenance model and are governed by the permissions of the deployment environment; only work submitted through SFlow Workflows receives automatic run history and result tracking.

## Consequences

- SFlow remains useful as a general project workspace and debugging environment.
- A terminal command can change files or consume resources without appearing in SFlow's scientific history.
- Deployment owners must use operating-system, container, and scheduler permissions to control terminal users.
