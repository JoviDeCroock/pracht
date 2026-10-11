---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
"@pracht/content": patch
---

SSG pages with a `markdown` export and no middleware now also publish it at `<path>.md` (`/index.md` for the root), linked from the page's `<head>` and from `llms.txt`, and served at the same URL by `pracht dev`; set `pracht({ markdownFiles: false })` to keep Markdown behind `Accept` negotiation only.
