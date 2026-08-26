---
"@pracht/core": minor
"@pracht/cli": minor
---

Add `agents.mcp.auth`: OAuth 2.0 resource-server metadata and bearer-token
challenges for the remote MCP endpoint.

Configuring it publishes RFC 9728 metadata, challenges unauthenticated requests,
redirects non-canonical resource URLs before authentication, validates OAuth
scope syntax, and surfaces the principal from your server-only verifier as
request-local `context.tokenAuth`. A throwing verifier is logged once while
still failing closed. Apps that omit `auth` are unchanged.
