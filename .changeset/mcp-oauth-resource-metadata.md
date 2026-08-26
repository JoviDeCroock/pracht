---
"@pracht/core": minor
"@pracht/cli": minor
---

Add `agents.mcp.auth`: OAuth 2.0 resource-server metadata and bearer-token
challenges for the remote MCP endpoint.

Configuring it publishes RFC 9728 metadata, challenges unauthenticated requests,
and surfaces the principal from your server-only verifier as `context.tokenAuth`.
Apps that omit `auth` are unchanged.
