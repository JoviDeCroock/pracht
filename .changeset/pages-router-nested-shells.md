---
"@pracht/vite-plugin": minor
"@pracht/cli": minor
---

An `_app.tsx` in a pages subdirectory is now registered as a directory-scoped shell (`pages:blog` for `pages/blog/_app.tsx`) and wraps every route in that subtree. Like a group's `shell` in an explicit manifest, the nearest `_app` replaces its parent rather than rendering inside it, so a directory shell owns its own `head()` and `headers()`.
