---
"@pracht/capabilities": minor
"@pracht/core": patch
"@pracht/cli": patch
---

`defineCapability()`, the build, and `pracht verify` now apply one set of capability contract rules with the same error messages, and `pracht typegen` also fails when MCP exposure, MCP scopes, `agentPolicy`, or `middleware` differ between the executed module and the source.
