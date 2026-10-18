---
"@pracht/capabilities": patch
"@pracht/core": patch
---

Human-mode approvals now bind the end user (the principal resolver, or the verified OAuth subject on remote MCP), and a Web Bot Auth key alone opens a separate proposal per prepare, so one user of a shared agent can no longer spend another user's approval.
