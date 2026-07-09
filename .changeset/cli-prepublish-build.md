---
"@pracht/cli": patch
---

Add a `prepublishOnly` build hook so `@pracht/cli` is rebuilt when published. The release workflow no longer runs a separate top-level build before publishing; each package is now built by its own `prepublishOnly` during staged publish.
