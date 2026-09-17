---
"@pracht/vite-plugin": patch
"@pracht/cli": patch
---

Refuse a build with `build.cssCodeSplit: false` instead of emitting pages that link no stylesheet at all, and report the same setting from `pracht doctor`.
