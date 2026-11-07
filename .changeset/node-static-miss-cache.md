---
"@pracht/adapter-node": patch
---

Server-rendered routes on the Node adapter no longer check the filesystem for a static file on every request; a missing path is rechecked at most once a second.
