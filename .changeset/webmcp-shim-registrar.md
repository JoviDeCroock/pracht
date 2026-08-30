---
"@pracht/vite-plugin": patch
---

The generated WebMCP shim now registers page tools through `@pracht/capabilities/webmcp` instead of inlining the registration runtime, so pracht apps and standalone sites share one registration and annotation policy.
