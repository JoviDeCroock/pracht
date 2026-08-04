---
"@pracht/cli": patch
"@pracht/vite-plugin": patch
---

Harden capability boundary checks across canonical file paths and module-load
failures.

The Vite plugin now compares canonical paths for app manifests, route module
directories, registered capability modules, and client imports, so symlinked
modules and path aliases cannot bypass manifest rewriting or server-only
client guards.

Type generation now leaves capability module-load failures to the existing
wiring checks instead of misreporting their null graph metadata as exposure
drift with an unrelated inline-literal remediation.
