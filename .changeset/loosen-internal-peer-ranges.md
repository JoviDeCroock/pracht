---
"@pracht/openapi": patch
"@pracht/content": patch
---

Publish internal peer dependency ranges as carets instead of exact pins.

`@pracht/openapi` previously shipped `"@pracht/core": "0.14.0"` (and the same for
`@pracht/cli` / `@pracht/vite-plugin`), and `@pracht/content` pinned
`@pracht/capabilities` the same way, because `workspace:*` is replaced with the
exact version at publish time. Any patch release of a peer therefore produced a
peer-dependency conflict for consumers and forced a republish of these two
packages. They now use `workspace:^`, which publishes `^0.14.0`.
