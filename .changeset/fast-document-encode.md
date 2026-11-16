---
"@pracht/core": patch
---

Server-rendered documents that contain a character outside Latin-1, such as an arrow, a curly quote, or an emoji, encode up to six times faster on Node 24 and up to three times faster on Node 22.
