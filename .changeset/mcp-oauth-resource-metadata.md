---
"@pracht/core": minor
"@pracht/cli": minor
"@pracht/adapter-cloudflare": patch
"@pracht/adapter-netlify": patch
"@pracht/adapter-node": patch
"@pracht/adapter-static": patch
---

Add OAuth resource-server protection for remote MCP endpoints.

Configure `agents.mcp.auth` to publish RFC 9728 metadata, validate bearer tokens
in a server-only hook, and expose verified principals as `context.tokenAuth`.
Builds and deployment adapters fail closed when routing or static exclusions
would bypass the protected endpoint. Verifier modules resolve consistently even
when source directories overlap. `pracht inspect agents` reports the OAuth
policy and flags unusable verifiers as blocked, and protected MCP eval
scenarios can send session-wide bearer auth.
