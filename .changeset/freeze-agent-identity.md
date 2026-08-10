---
"@pracht/capabilities": patch
"@pracht/core": patch
---

Protect verified Web Bot Auth identity from application-context mutation.
`context.agent` and its identity fields are now read-only immutable snapshots,
so later capability middleware, nested MCP policy, and audit events continue to
use the identity the transport actually verified.
