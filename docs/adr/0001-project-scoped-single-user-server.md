# Project-scoped single-user Server

SFlow runs as an independent Server for one Project. Both local and remote access require a single Project login credential; after login, terminal and filesystem capabilities are available according to the deployment's operating-system and service-node permissions. SFlow does not introduce platform-level multi-tenancy, collaboration, or billing in the initial product.

## Consequences

- Project state and control-plane lifecycle stay isolated per Server instance.
- Authentication is part of the SFlow access boundary in every deployment mode.
- The initial product has one access credential per Project and no user, role, or organization management.
- The first `sflow start` for a Project creates or requests that Project credential, and the credential can be rotated from Project settings.
- Deployment owners remain responsible for the permissions granted to an authenticated user, including terminal and filesystem access.
- Future multi-user features can be added behind the project boundary without changing the core scientific protocols.
