---
"@pracht/capabilities": minor
"@pracht/core": patch
"@pracht/cli": patch
---

Malformed capability `expose` values and invalid OAuth scopes now fail at definition and build time instead of being ignored. `pracht typegen` also fails when a capability's MCP exposure, scopes, `agentPolicy`, or `middleware` differ between the executed module and its source.
