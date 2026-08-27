---
"@pracht/core": minor
"@pracht/cli": minor
"@pracht/adapter-cloudflare": patch
"@pracht/adapter-netlify": patch
"@pracht/adapter-node": patch
"@pracht/adapter-static": patch
---

Add `agents.mcp.auth`: OAuth 2.0 resource-server metadata and bearer-token
challenges for the remote MCP endpoint.

Configuring it publishes RFC 9728 metadata, challenges unauthenticated requests,
redirects non-canonical resource requests before authentication, rejects
non-canonical configured OAuth identifiers, validates OAuth scope syntax and
security option names, rejects static or dynamic API-route collisions and
Netlify exclusions that shadow metadata, and surfaces the principal from your
server-only verifier as request-local `context.tokenAuth`. A throwing verifier
is logged once while still failing closed. Metadata routes take precedence over
copied static files, and `pracht plan` reports OAuth policy changes. Apps that
omit `auth` are unchanged. Nested calls retain the verified OAuth principal,
ambiguous verifier suffixes fail closed, and root endpoints accept their
canonical slashless resource identifier. Netlify metadata exclusions are
rejected only when MCP OAuth is enabled. Static exports now reject
`agents.mcp`, which requires a request runtime.
