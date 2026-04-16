---
"@pracht/vite-plugin": patch
---

Preserve import/export attributes during partial client-module stripping rewrites
and correctly prune dead server-only imports when names are shadowed by loop,
switch, catch, parameter, label, or hoisted `var` bindings, or when matching
identifiers only appear inside meta-property syntax such as `import.meta` and
`new.target`.
