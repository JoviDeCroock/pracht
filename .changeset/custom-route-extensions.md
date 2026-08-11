---
"@pracht/vite-plugin": minor
"@pracht/cli": patch
---

Replace built-in TSRX route handling with the format-agnostic `additionalExtensions` plugin option. Configured dot-prefixed extensions now participate in route and shell discovery, pages routing, dependency optimization, loader hints, client export stripping, verification, and generated-type watching; custom formats remain responsible for supplying their own Vite transform and TypeScript declaration.
