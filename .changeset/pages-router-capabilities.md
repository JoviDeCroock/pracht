---
"@pracht/vite-plugin": minor
"@pracht/cli": minor
"@pracht/capabilities": minor
"create-pracht": patch
---

The pages router now registers every module in `src/capabilities/` as a capability, so HTTP endpoints, WebMCP, remote MCP, `<Form capability>`, typed clients, and `pracht eval` work without a manifest. A module names itself with `defineCapability({ name })` or takes its file stem, and the name must map back to its file with dots written as hyphens.

`agents`, `constraints`, and `notFound` come from named exports of a root-level `src/pages/_app.config.ts`, which the generated manifest passes to `defineApp()` verbatim.
