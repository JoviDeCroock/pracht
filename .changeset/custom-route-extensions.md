---
"@pracht/vite-plugin": minor
"@pracht/cli": patch
---

Add the format-agnostic `additionalExtensions` plugin option while preserving built-in TSRX discovery and its ambient declaration for compatibility. Configured dot-prefixed extensions now participate in route and shell discovery, pages routing, loader hints, client export stripping, verification, and generated-type watching. Vite-scannable formats join initial dependency scanning; other custom formats remain responsible for their optimizer integration, source transform, and TypeScript declaration.
