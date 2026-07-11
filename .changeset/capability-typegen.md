---
"@pracht/cli": minor
"@pracht/core": minor
"@pracht/vite-plugin": patch
---

Generated TypeScript types for capabilities. `pracht typegen` now emits `src/pracht-capabilities.d.ts` from the capability graph's JSON Schemas, registering input/output types on `Register["capabilities"]`. With that file in the program, `invokeCapability()`, the browser's `callCapability()`, and `createCapabilityTestHost().invoke()` infer both sides from the capability name — the untyped `invokeCapability<Output>(...)` form keeps working for unregistered names. The app graph (`pracht inspect capabilities --json` and the MCP `inspect_capabilities` tool) now includes each capability's input/output schemas.
