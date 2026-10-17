---
"@pracht/capabilities": patch
"@pracht/core": patch
"@pracht/cli": patch
---

A capability module that fails to load now makes only that capability unavailable and is retried on the next request, page views no longer import capability modules, and `pracht dev` reads capabilities from source instead of running their modules at startup.
