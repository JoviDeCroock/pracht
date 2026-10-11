---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
---

SSG pages with a Markdown representation are now also published at `<path>.md` (`/index.md` for the root), linked from the page's `<head>` and from `llms.txt`, and served at the same URL by `pracht dev`; set `pracht({ markdownFiles: false })` to keep Markdown behind `Accept` negotiation only.
