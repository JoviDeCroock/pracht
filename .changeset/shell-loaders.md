---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
---

Shells can export a `loader` whose data `useShellData()` reads from the shell and every route inside it, loaded alongside the route loader and reused on client navigations that stay in the same shell. `pracht typegen` types `useShellData("app")` from the shell's loader, and `pracht generate shell --loader` scaffolds one.
