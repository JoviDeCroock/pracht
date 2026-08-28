---
"@pracht/vite-plugin": patch
"create-pracht": patch
---

Publish `virtual.d.ts` and expose it as `@pracht/vite-plugin/virtual`, so apps installed from npm can typecheck `virtual:pracht/*` imports; new scaffolds include it in `compilerOptions.types` automatically.
