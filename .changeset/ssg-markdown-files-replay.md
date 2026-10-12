---
"@pracht/core": patch
"@pracht/cli": patch
"@pracht/vite-plugin": patch
---

A page's `<path>.md` file is now published only when the page answers a build-time `Accept: text/markdown` request with Markdown, so a loader that redirects or rejects that request no longer has its `markdown` export exposed as a public static file.
