---
"@pracht/capabilities": minor
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
---

Add the capability core and WebMCP projection. The new `@pracht/capabilities` package provides `defineCapability()` — a typed, protocol-neutral application operation with a dependency-free JSON Schema subset validator, effect classes (`read`/`write`/`destructive`), named middleware, and explicit exposure. Capabilities register in the app manifest via `defineApp({ capabilities: { ... } })` and are private by default.

- `@pracht/core` resolves the capability registry, serves the HTTP projection (`POST /api/capabilities/<name>` with a typed `{ ok, data | error }` envelope, input/output validation, middleware, CSRF, and production redaction), exposes `invokeCapability()` for direct server-side use, and extends `buildAppGraph()`/devtools with a capabilities section.
- `@pracht/vite-plugin` generates `virtual:pracht/capabilities` (browser `callCapability()` over the HTTP projection) and `virtual:pracht/webmcp` (a feature-detected WebMCP page-tool registration shim targeting `document.modelContext.registerTool`), both zero-cost when unused, and registers capability modules server-side.
- `@pracht/cli` adds `pracht inspect capabilities`, an `inspect_capabilities` MCP tool, and `pracht verify` checks: exposed capabilities must declare a full contract, destructive capabilities cannot be exposed, `expose.webmcp` requires `expose.http`, and unsupported JSON Schema keywords fail verification.
