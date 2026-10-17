---
"@pracht/core": patch
---

A client navigation whose route chunk fails to load, such as in a tab left open across a deploy, now loads the target as a full page instead of changing the URL while the old page stays on screen.
