---
"@pracht/core": minor
---

Add `useBlocker()`, which stops a client navigation before it commits so a route can guard unsaved work. It covers `<Link>` clicks, `useNavigate()`, back/forward traversals, and — unless you opt out — document unloads via `beforeunload`; resolve the returned blocker with `proceed()` or `reset()`.
