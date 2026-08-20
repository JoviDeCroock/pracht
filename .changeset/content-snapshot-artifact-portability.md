---
"@pracht/content": patch
---

Preserve prototype-named JSON properties in generated runtime snapshots and
reject content artifacts that would replace Netlify's root `_headers` control
file during deployment finalization.
