---
"@pracht/cli": patch
"create-pracht": patch
---

The CLI now checks the Node version before loading anything else, so an unsupported Node fails with `pracht requires Node >= 22.18 (found 18.17.1).` instead of a `SyntaxError` about a missing `node:util` export. Scaffolded apps ship an `.nvmrc` and an `engines.node` field so build images pick a supported version.
