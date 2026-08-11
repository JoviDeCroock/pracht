---
title: LLM Content Negotiation
lead: Give AI agents first-class Markdown at the same URLs your readers use. pracht routes can negotiate on `Accept: text/markdown`, publish `/llms.txt`, and keep HTML as the browser default.
breadcrumb: LLMs
prev:
  href: /docs/agents
  title: The Agentic Web
next:
  href: /docs/agent-workflow
  title: AI-Assisted Authoring & Review
---

## One URL, Two Representations

pracht can serve the same route as either a normal HTML page or raw Markdown. Browsers keep receiving rendered HTML, while agents that explicitly ask for Markdown get the source document without navigation chrome, hydration state, or scraped layout noise.

```sh
# Human-readable HTML
curl https://pracht.resynapse.dev/docs/routing

# Agent-readable Markdown
curl -H "Accept: text/markdown" https://pracht.resynapse.dev/docs/routing
```

The HTML and Markdown responses include `Vary: Accept`, so caches keep both representations separate. Routes without a `markdown` export do not vary on `Accept`; their prerendered document continues to answer markdown-preferring requests instead of falling through to a server render.

---

## Opt In with a Markdown Export

Any route can expose an agent version by exporting a `markdown` string or async function. Pracht runs middleware and the loader first, then passes the resolved data and route arguments to the function.

```tsx [src/routes/pricing.tsx]
export const markdown = `# Pricing

- Starter: free
- Pro: usage-based
- Enterprise: contact sales
`;

export function Component() {
  return <PricingPage />;
}
```

```tsx [src/routes/guide.tsx]
import type { MarkdownArgs } from "@pracht/core";

export async function markdown({ data, params }: MarkdownArgs<typeof loader>) {
  return data.content.source;
}
```

Every opted-in route also has a native `.md` alias. For example,
`/guide/v10/hooks.md` rematches `/guide/:version/:name` and forces Markdown
without an `Accept` header. `/index.md` aliases `/` by default; configure it as
`defineApp({ markdown: { homeAlias: "/readme.md" } })` or disable the home alias
with `homeAlias: false`. Route-state requests are excluded from both aliasing and
content negotiation, but cross-site `?_data=1` query parameters remain ordinary
document requests. Exact declared `.md` paths stay literal. If a home alias and
another route's generated alias both target Markdown-capable routes, Pracht
reports the collision so the app can choose a different `homeAlias`.

For the docs site, the Markdown route plugin emits that export automatically for every `.md` page:

```ts [vite-plugin-md.ts]
export const markdown = rawSource;
```

That means every documentation page is already an LLM-friendly endpoint.

---

## Accept Header Rules

pracht only switches to Markdown when the client explicitly prefers it. Browser-style wildcards like `*/*` still receive HTML.

| Request header                                  | Result              |
| ----------------------------------------------- | ------------------- |
| `Accept: text/html`                             | Rendered HTML       |
| `Accept: */*`                                   | Rendered HTML       |
| `Accept: text/markdown`                         | Raw Markdown        |
| `Accept: text/html;q=0.8, text/markdown;q=1.0`  | Raw Markdown        |
| `Accept: text/html;q=1.0, text/markdown;q=0.5`  | Rendered HTML       |

This makes the feature safe to enable on public pages: humans get the polished app, and agents get a deterministic source format when they ask for it.

---

## Discovery with llms.txt

pracht can generate `/llms.txt` for you: the vite plugin's `llmsTxt` option emits the file from the resolved app graph — every page URL, every API endpoint with its methods, and every HTTP-exposed [capability](/docs/capabilities) with its dispatch endpoint, effect class, and description. Routes with a `markdown` export are annotated with `` supports `Accept: text/markdown` ``.

```ts [vite.config.ts]
pracht({
  adapter: nodeAdapter(),
  llmsTxt: { origin: "https://example.com" }, // title/description default to package.json
});
```

`pracht build` writes `dist/client/llms.txt` and the dev server serves it live at `/llms.txt`.

This docs site needs curated sections and an `llms-full.txt` bundle with inlined page content, so it uses a custom frontmatter-driven plugin instead:

- `/llms.txt` — a concise map of the docs with titles, descriptions, and canonical URLs.
- `/llms-full.txt` — a single Markdown bundle with the full source of every listed page.

```sh
curl https://pracht.resynapse.dev/llms.txt
curl https://pracht.resynapse.dev/llms-full.txt
```

The docs Vite config wires those files with a tiny plugin that scans the route manifest and frontmatter:

```ts [examples/docs/vite.config.ts]
llmsTxt({
  origin: "https://pracht.resynapse.dev",
  routesFile,
  title: "pracht",
  description:
    "A full-stack Preact framework built on Vite with hybrid rendering and a unified data-loading model.",
  sections: [{ heading: "Docs", match: "/docs" }],
});
```

Agents can start at `/llms.txt`, follow the canonical route URLs, and request any page with `Accept: text/markdown` when they need exact source.

---

## Framework Docs for Agents

Content negotiation and `llms.txt` cover your site's content. For the framework's own conventions, the CLI ships an embedded authoring guide: `pracht llms` prints it, and `pracht llms --write` saves it as `llms.txt` in the app root so coding agents working in the repo pick it up.

```sh
pracht llms
pracht llms --write
```

The MCP server (`pracht mcp`) exposes the same guide via the `get_docs` tool, alongside `plan` and `report` for app-graph diffs and PR reports. See [AI-Assisted Authoring & Review](/docs/agent-workflow) for the full workflow.

---

## Why It Helps

- **No scraping required** — agents receive source Markdown instead of parsing rendered UI.
- **Canonical URLs stay canonical** — the same page URL works for humans, crawlers, and LLM tools.
- **Static pages still work** — adapters skip static HTML asset serving for Markdown requests so SSG routes can negotiate through the framework.
- **Cache-safe by default** — `Vary: Accept` separates the HTML and Markdown responses.
- **Framework-native** — hand-authored `.tsx` routes and transformed `.md` routes use the same `markdown` export contract.
