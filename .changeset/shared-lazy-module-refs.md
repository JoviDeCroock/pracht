---
"@pracht/vite-plugin": patch
---

`() => import("./file")` module refs now work in local modules the app manifest imports, such as a shared `agents` constant, instead of failing with "Invalid ModuleRef".
