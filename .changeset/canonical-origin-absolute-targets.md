---
"@pracht/adapter-node": patch
---

Harden `canonicalOrigin` request URL handling by normalizing absolute-form and network-path request targets to their path/query/hash before resolving against the canonical origin.
