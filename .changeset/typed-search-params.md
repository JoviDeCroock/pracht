---
"@pracht/core": minor
"@pracht/cli": minor
"@pracht/vite-plugin": minor
"@pracht/test": minor
---

Route modules can export a `search` Standard Schema: loaders and `useSearch()` get the parsed, typed query, `<Link search>` and `href()` are type-checked against it, and a rejected query renders the route's error boundary with a 400.
