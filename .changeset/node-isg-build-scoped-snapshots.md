---
"@pracht/adapter-node": patch
---

Two builds serving one `dist/` during a deploy rollover no longer overwrite each other's regenerated ISG pages, and snapshots of retired builds are cleaned up.
