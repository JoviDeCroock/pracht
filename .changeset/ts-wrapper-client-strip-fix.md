---
"@pracht/vite-plugin": patch
---

Fix client-module stripping so imports referenced through TypeScript expression
wrappers such as `as`, non-null (`!`), and `satisfies` are preserved in the
browser bundle instead of being pruned as dead code.
