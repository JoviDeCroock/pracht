---
"@pracht/cli": patch
"create-pracht": patch
---

Running the CLI on an unsupported Node now fails with `pracht requires Node >= 22.18 (found 18.17.1).`, and new apps ship an `.nvmrc` and an `engines.node` field.
