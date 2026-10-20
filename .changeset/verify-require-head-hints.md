---
"@pracht/cli": patch
---

The `require-head` constraint in `pracht verify` now follows the build's head hints, so a Markdown route whose head comes from frontmatter passes, as does a custom-format route the build cannot prove headless.
