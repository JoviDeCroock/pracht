---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
---

Shells can export a `loader`, read with `useShellData()` from the shell and every route inside it and reused on client navigations that stay in the shell. `pracht typegen` types `useShellData("app")`, and `pracht generate shell --loader` scaffolds one.
