---
"@pracht/capabilities": patch
"@pracht/core": patch
"@pracht/vite-plugin": patch
"@pracht/cli": patch
---

Harden capability projection after review:

- reject custom HTTP paths that URL parsing can reinterpret as cross-origin or as a different pathname;
- scope manifest extraction to the exported `defineApp()` configuration and require a statically analyzable default capability export;
- require inline effect metadata for HTTP client generation and verification; and
- carry the server-verified effect class into enhanced capability forms so successful read-only submissions do not revalidate route data.
