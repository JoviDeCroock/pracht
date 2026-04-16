---
"@pracht/vite-plugin": patch
---

Refine client-module stripping with a dedicated scope analyzer so dead server-only imports drop correctly across additional syntax patterns such as loop scopes, catch bindings, labels, `import.meta`, and JSX/component references.
