---
"@pracht/core": patch
"create-pracht": patch
---

Make the `<Link href>` compile error name the fix.

`href` is the muscle-memory prop from every other router, so it is the first
wall a new pracht app hits. `LinkProps` omitted it, which left TypeScript to
guess: `Property 'href' does not exist … Did you mean 'ref'?` — a suggestion
that sends the reader hunting for a typo rather than at the API. The prop is now
declared with a single-value string type carrying the guidance, so the compiler
prints it:

```
Type '"/blog/hello"' is not assignable to type '<Link> navigates by route id:
use <Link route="home"> (with `params` for dynamic segments), or a plain
<a href> for external and user-provided URLs.'
```

`create-pracht` also seeds a Conventions section in `AGENTS.md` naming the
route-id API, since that file is what a coding agent reads before writing its
first link.
