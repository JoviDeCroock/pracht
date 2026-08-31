---
"@pracht/core": patch
---

The capability dispatch, agent trust, and remote MCP internals now live in `@pracht/capabilities/server`; every `@pracht/core` export is unchanged and re-exported from there, and process-level registrations (audit hooks, approval store, confirmation secret) are shared with standalone capability hosts.
