---
"@pracht/core": minor
"@pracht/cli": minor
"@pracht/vite-plugin": minor
"@pracht/test": minor
---

Route modules can export a `search` Standard Schema to get validated, typed query params: loaders and `head()` receive the parsed value as `args.search`, components read it with `useSearch()`, `<Link search>`, `navigate()`, and `href()` are type-checked against the schema's input, and a rejected query renders the route's error boundary with a 400 and the validation issues.
