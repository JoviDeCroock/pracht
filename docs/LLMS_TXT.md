# llms.txt

Pracht can emit an [llms.txt](https://llmstxt.org) file — a markdown index of
your site's pages, API endpoints, and [capabilities](CAPABILITIES.md) that LLM
agents (and audits such as Lighthouse's Agentic Browsing check) read to
discover what a site offers. The file is generated from the resolved app
graph, so it always matches the routes the app actually serves. The feature is
opt-in and has zero cost when disabled.

## Enabling

```ts
// vite.config.ts
pracht({
  adapter: nodeAdapter(),
  llmsTxt: {
    title: "My App", // defaults to package.json "name"
    description: "What the app does.", // defaults to package.json "description"
    origin: "https://example.com", // emit absolute URLs; relative when omitted
    include: ["pages", "api", "capabilities"], // sections to emit (default: all)
    exclude: ["/dashboard", "/admin/**"],       // paths to leave out
    maxPagesPerRoute: 50,                       // per dynamic route (0 = all)
  },
})
```

### Excluding routes

`llms.txt` is a list of URLs the app *invites* an agent to fetch, so anything
an anonymous agent cannot use does not belong in it — pages behind an auth
middleware answer `401`, internal tooling answers `403`, and a deliberate error
route answers `500`. Nothing about a middleware tells the framework whether it
gates or merely logs, so the exclusion is yours to declare:

```ts
llmsTxt: { exclude: ["/dashboard", "/admin/**", "/internal/**"] }
```

Patterns use the same segment globs as `defineApp({ constraints })` — `*`
matches one segment, a trailing `**` matches the rest — and are matched against
the emitted paths, so `/blog/**` also covers the prerendered instances of
`/blog/:slug`. Excluded paths are dropped from both the Pages and API sections.

`llmsTxt: {}` is enough — the title falls back to the app's package.json
`name` and the description to its `description` (the blockquote is omitted
when neither is set).

### Large collections

A dynamic SSG/ISG route contributes at most `maxPagesPerRoute` prerendered
instances to the Pages section — 50 by default, per route, applied after
`exclude`. llms.txt is an index, not a sitemap: a 5,000-post blog expanded
through `getStaticPaths()` produces a 5,000-line, 180 KB file, which is larger
than most agent context budgets and tells an agent nothing the first fifty
entries did not.

Truncation is never silent. The section ends with a line naming the route and
the count:

```
_4,950 more prerendered pages under `/blog/:slug` are not listed. Raise
`llmsTxt.maxPagesPerRoute` to include them._
```

Set `maxPagesPerRoute: 0` to list every instance.

## What it does

- **Build** — `pracht build` writes `dist/client/llms.txt`. All four adapters
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

## Capabilities

- [notes.create](/api/capabilities/notes/create): POST (write) — Add a new note.
- [notes.purge](/api/capabilities/notes/purge): POST (destructive, requires confirmation) — Delete matching notes.
- [notes.search](/api/capabilities/notes/search): POST (read) — Find notes matching a query.
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
- Routes with a server-only `markdown` export, or `markdown: true` route
  metadata for middleware-owned negotiation (see
  [docs/DATA_LOADING.md](DATA_LOADING.md)), are annotated with
  `supports \`Accept: text/markdown\``.
- Link names are the route paths themselves. Page titles are not derivable
  statically (`head()` needs a request), and paths are unambiguous for agents.

### API

API routes are listed as endpoint patterns (including dynamic params such as
`/api/users/:id`) with their detected HTTP methods as the note. Handlers
exported only as `default` produce no method note.

### Capabilities

Every HTTP-exposed [capability](CAPABILITIES.md) is listed by name, linking to
its dispatch endpoint, with its effect class and description as the note.
Destructive capabilities are annotated with `requires confirmation` — their
first dispatch answers `409 confirmation_required` per the
[agent trust layer](AGENT_TRUST.md). Private capabilities (no `expose`) are
omitted: there is no URL an agent could call. Entries are sorted by capability
name.

## Notes

- `/llms.txt` is reserved while the option is enabled; an app route at that
  path is shadowed in dev (a warning is logged) and by the static file in
  production.
- If you need curated sections or an `llms-full.txt` with inlined page
  content, use the opt-in
  [`@pracht/content` collection helper](CONTENT.md#static-artifacts). The docs
  site generates both files from the same registry that compiles its Markdown
  route modules, so no second manifest/filesystem reader can drift.
