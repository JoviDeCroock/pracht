---
"@pracht/markdown": minor
---

Markdown routes no longer ship their compiled HTML as JavaScript, so each page's route chunk shrinks to a few hundred bytes. The rendered Markdown never hydrates, and `useRouteData()` on a Markdown route now returns `{ html }`.
