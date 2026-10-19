---
"@pracht/vite-plugin": patch
---

Route hints keep working when a routes or shells directory is configured through an alias such as `/src/other/../routes`, and a dev save re-parses only the file that changed.
