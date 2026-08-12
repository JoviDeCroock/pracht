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
    details: "Start with the guides, then use the API reference.",
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

## What it does

- **Build** — `pracht build` writes `dist/client/llms.txt`. All three adapters
  serve it as a regular static file: the Node handler and the Vercel Build
  Output `handle: filesystem` route pick it up directly, and the Cloudflare
  worker serves it through the `ASSETS` binding.
- **Dev** — the dev server serves `/llms.txt` live from the current app graph
  (routes added or removed show up on the next request). With the Cloudflare
  adapter the Cloudflare vite plugin owns the dev server, so `/llms.txt` is
  only available in build output there.

When `full` or `markdownSuffix` is enabled, the same generator also writes
`llms-full.txt` and concrete page assets such as `docs/getting-started.md`.
The dev server serves those generated paths live too. Cloudflare's Vite plugin
still owns its development server, so all generated llms.txt artifacts are
build-only there.

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
- Routes with a server-only `markdown` export (Markdown-for-Agents content
  negotiation, see [docs/DATA_LOADING.md](DATA_LOADING.md)) are annotated with
  `supports \`Accept: text/markdown\``.
- Link names are the route paths by default. Use `page()` when a route module or
  content plugin exposes suitable static metadata; Pracht does not call
  request-dependent `head()` functions or assume a content format.

### Custom page metadata and full source

`page({ path, data })` receives each concrete path and its loaded route-module
exports. It can return `title`, `description`, and `section`, or `false` to omit
the page. `render({ path, data })` returns that document's Markdown source.
Both hooks may be async. They are bundled into the generated server module, so
keep them self-contained instead of closing over values from `vite.config.ts`.

```ts
llmsTxt: {
  origin: "https://example.com",
  details: "Start with Guides; Reference contains exhaustive API details.",
  page: ({ path, data }) => ({
    title: data.content.meta.title,
    description: data.content.meta.description,
    section: data.content.section,
  }),
  render: ({ data }) => data.content.source,
  full: true,
  markdownSuffix: true,
}
```

With these options, page links point at generated Markdown assets (`/guide.md`,
`/index.md` for `/`, or `/index/index.md` for a distinct `/index` route) and
`/llms-full.txt` concatenates every successfully rendered document. A page
whose renderer returns `undefined` stays linked to its normal URL and is
omitted from both the per-page assets and full corpus. Dynamic SSG/ISG pages
still expand through `getStaticPaths()` before either hook runs, so each
callback receives a concrete `path`. Excluded and framework-reserved concrete
paths are removed before either callback runs.

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

- Every generated path is reserved while the option is enabled. A matching app
  route is shadowed in dev (with a warning) and by the static file in
  production; matching SSG/ISG output is not prerendered at that path. A
  matching `public/` file is shadowed in dev and overwritten during build, with
  a warning. SSG/ISG routes below a generated file path are also left to the
  runtime instead of producing an incompatible file/directory layout.
- The docs example uses `page`, `render`, `full`, and `markdownSuffix` to map
  its own frontmatter format without adding that format to Pracht.
