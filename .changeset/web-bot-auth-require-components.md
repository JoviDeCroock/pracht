---
"@pracht/capabilities": minor
"@pracht/core": minor
---

`agents.webBotAuth.requireComponents` (for example `["@method", "@path"]`) makes Web Bot Auth signatures verify only when they cover those components, so a captured signature can no longer be replayed onto another endpoint.
