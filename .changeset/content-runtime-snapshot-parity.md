---
"@pracht/content": patch
---

Keep request-time loader and Markdown helpers on the filesystem-free runtime
entry, and reject sparse snapshot arrays before serialization can replace their
holes with `null`. Fail client imports of server-only collection snapshots
before private content can enter browser bundles, keep frontmatter titles and
multiline descriptions inside one safe `llms.txt` entry, and avoid claiming a
Markdown route is registered when static verification only sees the content
plugin.
