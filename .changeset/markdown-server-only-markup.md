---
"@pracht/markdown": minor
---

Markdown routes no longer ship their compiled HTML as JavaScript, so each page's route chunk shrinks to a few hundred bytes. The rendered Markdown never hydrates; set `serverOnly: false` on a collection to keep its HTML in the route chunk.
