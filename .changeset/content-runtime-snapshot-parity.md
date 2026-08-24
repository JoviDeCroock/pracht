---
"@pracht/content": patch
---

Keep request-time loader and Markdown helpers on the filesystem-free runtime
entry, and reject sparse snapshot arrays before serialization can replace their
holes with `null`.
