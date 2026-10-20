---
"@pracht/cli": patch
"@pracht/vite-plugin": patch
---

When the app graph cannot be resolved, `pracht verify` and `pracht doctor` read routes from the manifest the way the build does, and `pracht dev` prints the error and the route count instead of only its URLs.
