---
"@pracht/cli": patch
---

`pracht doctor` and `pracht verify` now warn when `tsconfig.json` uses a `moduleResolution` that predates package `exports` (`"node"`, `"node10"`, `"classic"`), which leaves every `@pracht/core` import unresolvable to `tsc` while Vite still builds the app.
