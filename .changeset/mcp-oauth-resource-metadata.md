---
"@pracht/core": minor
"@pracht/cli": minor
---

Add `agents.mcp.auth`: OAuth 2.0 resource-server metadata and bearer-token
challenges for the remote MCP endpoint.

Configuring it serves RFC 9728 protected-resource metadata at
`/.well-known/oauth-protected-resource`, answers unauthenticated `/mcp` requests
with the `WWW-Authenticate` challenge MCP hosts follow (401 `invalid_token`,
403 `insufficient_scope`), and surfaces the principal from your `verify` module
as `context.tokenAuth`. Pracht stays the resource server — token validation is
your hook. Apps that omit `auth` are unchanged and pay nothing for it.
