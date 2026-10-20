---
"@pracht/capabilities": minor
"@pracht/core": minor
"@pracht/cli": minor
"@pracht/vite-plugin": patch
---

An app with `agents.confirmation.mode: "human"` and capabilities now refuses to start (and `pracht build` and `pracht verify` fail) unless `setCapabilityApprovalPrincipalResolver()` or `agents.mcp.auth` can identify the end user, and a destructive call that still resolves no end user is refused with `403 confirmation_unavailable`. To migrate, call `setCapabilityApprovalPrincipalResolver()` from a capability module or a server-only module it imports, returning the signed-in user's id, or protect remote MCP with `agents.mcp.auth`.
