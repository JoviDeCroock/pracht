---
"@pracht/cli": patch
---

`pracht verify` now reports middleware inside a route or shell directory even when the manifest only has a commented-out `__PRACHT_EJECTED_PAGES_LAYOUT__` marker, matching what the build bundles.
