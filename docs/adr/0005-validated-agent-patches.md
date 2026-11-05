# Agents modify state through validated patches

Workflow, Node, and Results Agents run as three independently configured Agent instances, each with its own prompt, tools, context, and mutation scope. They propose typed patches against Workflow IR or Result View IR. Every mutation that can affect computation, data binding, or scientific interpretation passes schema validation, semantic checks, preview/diff, and explicit application with rollback; read-only diagnosis may run automatically, and Agents do not write around the protocols or emit arbitrary frontend code.

## Consequences

- Agent actions are reviewable and reversible.
- Draft changes can be explored without changing an executable version.
- The validation layer is a shared boundary between natural-language interaction and persisted scientific state, while each Agent remains independently replaceable and auditable.
