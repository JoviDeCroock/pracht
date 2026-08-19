---
"@pracht/cli": patch
"@pracht/content": patch
---

Reject generated content artifacts that collide with files in `public/`,
prerendered pages, Pracht's internal content-header manifest, or another
artifact through case-folded and file/directory output paths. Apply the same
portable collision rules to the core `llms.txt` and OpenAPI generators, and
only infer source locales from actual directory segments rather than a
top-level file whose name matches a locale.
