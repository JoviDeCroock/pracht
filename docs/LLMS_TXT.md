# llms.txt

Pracht can emit an [llms.txt](https://llmstxt.org) file — a markdown index of
your site's pages and API endpoints that LLM agents (and audits such as
Lighthouse's Agentic Browsing check) read to discover what a site offers. The
file is generated from the resolved app graph, so it always matches the routes
the app actually serves. The feature is opt-in and has zero cost when disabled.

## Enabling

```ts
// vite.config.ts
pracht({
  adapter: nodeAdapter(),
  llmsTxt: {
    title: "My App", // defaults to package.json "name"
    description: "What the app does.", // defaults to package.json "description"
    origin: "https://example.com", // emit absolute URLs; relative when omitted
    include: ["pages", "api"], // sections to emit (default: both)
  },
})
```

`llmsTxt: {}` is enough — the title falls back to the app's package.json
`name` and the description to its `description` (the blockquote is omitted
when neither is set).

## What it does

- **Build** — `pracht build` writes `dist/client/llms.txt`. All three adapters
  serve it as a regular static file: the Node handler and the Vercel Build
  Output `handle: filesystem` route pick it up directly, and the Cloudflare
  worker serves it through the `ASSETS` binding.
- **Dev** — the dev server serves `/llms.txt` live from the current app graph
  (routes added or removed show up on the next request). With the Cloudflare
  adapter the Cloudflare vite plugin owns the dev server, so `/llms.txt` is
  only available in build output there.

## Output format

Per the [llms.txt spec](https://llmstxt.org): an H1 title, an optional
blockquote summary, and H2 sections containing markdown link lists.

```
# My App

> What the app does.

## Pages

- [/](/): supports `Accept: text/markdown`
- [/blog/hello-world](/blog/hello-world)
- [/pricing](/pricing)

## API

- [/api/echo](/api/echo): POST
- [/api/health](/api/health): GET
```

Output is deterministic: entries are sorted by path with a locale-independent
comparison, so repeated builds produce byte-identical files.

### Pages

- Static routes are always listed, whatever their render mode — they are real
  URLs an agent can fetch.
- Dynamic routes (`/blog/:slug`) are listed only when they are SSG/ISG routes
  with a `getStaticPaths()` export; each prerendered instance becomes its own
  entry. Dynamic SSR/SPA routes are skipped — there is no concrete URL to
  link.
- Routes with a server-only `markdown` export (Markdown-for-Agents content
  negotiation, see [docs/DATA_LOADING.md](DATA_LOADING.md)) are annotated with
  `supports \`Accept: text/markdown\``.
- Link names are the route paths themselves. Page titles are not derivable
  statically (`head()` needs a request), and paths are unambiguous for agents.

### API

API routes are listed as endpoint patterns (including dynamic params such as
`/api/users/:id`) with their detected HTTP methods as the note. Handlers
exported only as `default` produce no method note.

## Notes

- `/llms.txt` is reserved while the option is enabled; an app route at that
  path is shadowed in dev (a warning is logged) and by the static file in
  production.
- If you need curated sections or an `llms-full.txt` with inlined page
  content, keep using a custom plugin — see
  [examples/docs/vite-plugin-llms-txt.ts](../examples/docs/vite-plugin-llms-txt.ts)
  for a frontmatter-driven variant.
