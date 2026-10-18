---
"@pracht/capabilities": minor
"@pracht/core": minor
"@pracht/cli": minor
---

`agents.confirmation.mode: "human"` now refuses destructive calls with `403 confirmation_unavailable` (and the remote MCP endpoint refuses to serve) unless the end user is identified, because a Web Bot Auth key alone names the agent rather than the user. To migrate, call `setCapabilityApprovalPrincipalResolver()` from a server-only module to return the signed-in user's id, or protect remote MCP with `agents.mcp.auth`.
