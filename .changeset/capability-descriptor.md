---
"@pracht/capabilities": minor
"@pracht/core": patch
"@pracht/cli": patch
---

Malformed capability `expose` values (including a non-boolean `expose.mcp` and unknown keys such as `mpc`) and invalid OAuth scopes now fail at definition, in `pracht verify`, and at build time instead of being ignored. An `expose` that is not an inline literal now fails `pracht verify` as it fails the build, and `pracht typegen` and `pracht build` fail when a capability's exposure, scopes, `agentPolicy`, or `middleware` differ between the executed module and its source.
