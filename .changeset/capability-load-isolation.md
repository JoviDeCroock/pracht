---
"@pracht/capabilities": patch
"@pracht/core": patch
"@pracht/cli": patch
---

A capability module that fails to load now makes only that capability unavailable instead of every capability, page views no longer import capability modules, and the `pracht dev` startup banner reads capabilities from source instead of running their modules.
