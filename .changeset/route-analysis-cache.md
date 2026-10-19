---
"@pracht/vite-plugin": patch
---

Saving a file in `pracht dev` re-parses only the modules that changed instead of every route and shell module, so edits show up sooner in apps with many routes.
