---
"@pracht/cli": patch
"@pracht/content": patch
---

Reject generated content artifacts that collide with files in `public/`,
prerendered pages, Pracht's internal content-header manifest, or another
artifact through case-folded and file/directory output paths.
