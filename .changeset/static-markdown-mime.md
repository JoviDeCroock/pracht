---
"@pracht/adapter-node": patch
"@pracht/vite-plugin": patch
---

Static markdown is served as `text/markdown`, in dev and in production.

`@pracht/adapter-node`'s MIME table had no `.md` entry, so a markdown file in
the static output was served as `application/octet-stream` — browsers offered
it as a download and agents fetching it got a content type they had no reason
to parse. Apps publishing a skills catalog or docs corpus as plain files had to
route it through middleware to set the header by hand. `.md` and `.markdown`
now map to `text/markdown; charset=utf-8`, and `.txt` gained the `charset=utf-8`
it was missing (it matters for `llms.txt` with non-ASCII content).

The dev server had the matching gap from the other side: `.md` was not in its
static-asset extension list, so `pracht dev` handed those requests to the SSR
router and answered 404 for a file that existed in `public/`. Markdown now
resolves the same way in both.
