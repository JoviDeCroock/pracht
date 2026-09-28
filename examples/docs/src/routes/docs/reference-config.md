---
title: Configuration Reference
lead: Every option accepted by the `pracht()` Vite plugin and by `defineApp()`, with its default and a pointer to the guide that explains it.
breadcrumb: Configuration
prev:
  href: /docs/reference/api
  title: API Reference
next:
  href: /docs/reference/i18n
  title: i18n Reference
---

## `pracht()` — the Vite plugin

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { nodeAdapter } from "@pracht/adapter-node";

export default defineConfig({
  plugins: [pracht({ adapter: nodeAdapter() })],
});
```

Everything below is optional. The defaults match a `create-pracht` app, so most
apps pass only an `adapter`.

### Project layout

| Option | Default | Description |
| --- | --- | --- |
| `appFile` | `"/src/routes.ts"` | The route manifest. Ignored when `pagesDir` is set |
| `routesDir` | `"/src/routes"` | Where route modules are discovered |
| `shellsDir` | `"/src/shells"` | Where [shell](/docs/shells) modules are discovered |
| `middlewareDir` | `"/src/middleware"` | Where [middleware](/docs/middleware) modules are discovered |
| `apiDir` | `"/src/api"` | Where [API routes](/docs/api-routes) are auto-discovered |
| `serverDir` | `"/src/server"` | Server-only modules, never bundled for the client |
| `islandsDir` | `"/src/islands"` | Components hydrated on [`hydration: "islands"`](/docs/islands) routes |
| `capabilitiesDir` | `"/src/capabilities"` | [Capability](/docs/capabilities) modules registered in the manifest |
| `additionalExtensions` | `[]` | Extra route/shell extensions to discover, e.g. `[".vue"]`. Register the plugin that transforms them yourself. `.tsrx` needs no entry |

### Routing

| Option | Default | Description |
| --- | --- | --- |
| `adapter` | Node adapter | Deployment target. See [Adapters](/docs/adapters) |
| `pagesDir` | *(unset)* | Opt into [file-system routing](/docs/routing#pages-router-auto-discovery), e.g. `"/src/pages"`. Overrides `appFile` |
| `pagesDefaultRender` | `"ssr"` | Render mode for pages that do not export `RENDER_MODE`. Pages router only |

### Build

| Option | Default | Description |
| --- | --- | --- |
| `prerenderConcurrency` | `10` | Maximum SSG/ISG pages rendered in parallel by `pracht build` |
| `maxBodySize` | `1048576` (1 MiB) | Largest request body the dev SSR middleware accepts |
| `inlineCss` | `false` | Inline each page's route and shell CSS into the HTML instead of linking it. See [Performance](/docs/performance#css-per-page) |
| `budgets` | `{}` | Per-route gzip client-JS budgets, e.g. `{ "*": "120kb", "/dashboard": "200kb" }`; explicit paths override `"*"`. Exceeding one fails the build unless you pass `pracht build --no-budget-fail` |
| `precompileSsrJsx` | `false` | Precompile safe Preact JSX DOM subtrees in server (SSR/SSG) bundles. Client bundles are unchanged |
| `envSafety` | `{}` (enabled) | Fail the build when a production client chunk references a non-public env var. `{ allow: ["NAME"] }` permits specific ones; `false` disables the check. See [Environment Variables](/docs/env) |

### Client bundle

`client` compiles unused router features out of the client bundle, and adds
two that cost bytes only when you turn them on. Turn a feature off only if the
app does not use it: the router then ignores the matching route options and
`<Link>` props.

| Option | Default | Description |
| --- | --- | --- |
| `client.prefetch` | `true` | JS [prefetching](/docs/prefetching#shipping-less-javascript) from `route({ prefetch })` and `<Link prefetch>`. Off makes `prefetch()` a no-op |
| `client.navigationGuards` | `true` | [`useBlocker()`](/docs/data-loading#useblocker) navigation guards. Off makes `useBlocker()` never block; it warns in development |
| `client.hydrationWarnings` | `false` | Keep the [hydration-mismatch reporter](/docs/rendering#hydration-mismatch-warnings) in production client and islands bundles, to check a build before deploying it. Not for the build you ship |
| `client.richData` | `false` | Send loader `Date`, `Map`, `Set`, `BigInt`, and shared references to the browser [as those types](/docs/data-loading#dates-maps-and-other-rich-values) instead of as JSON |

An unknown `client` key is an error.

### Chunking

| Option | Default | Description |
| --- | --- | --- |
| `vendorChunk` | `true` | Add the Preact [vendor chunk group](/docs/performance#composing-with-your-own-chunking) to the app's own `build.rollupOptions.output`. `false` adds nothing |

### Agent surfaces

| Option | Default | Description |
| --- | --- | --- |
| `llmsTxt` | `false` | Emit [`llms.txt`](/docs/agents#llmstxt) from the resolved app graph |
| `llmsTxt.title` | package `name` | H1 title |
| `llmsTxt.description` | package `description` | Blockquote summary under the title; omitted when neither is set |
| `llmsTxt.origin` | *(unset)* | Origin prepended to every link, e.g. `"https://example.com"`. Links stay root-relative when omitted |
| `llmsTxt.include` | `["pages", "api", "capabilities"]` | Which sections to emit |
| `llmsTxt.exclude` | `[]` | Path patterns to leave out, using the same segment globs as `constraints` (`*` is one segment, trailing `**` is the rest) |
| `devPageTools` | `true` | Register the read-only `pracht_*` WebMCP [dev page tools](/docs/coding-agents#debugging-in-the-tab-dev-page-tools) on pages `pracht dev` serves. Never part of a build |

> [!NOTE]
> Agents fetch every URL `llms.txt` lists. Exclude what an anonymous agent
> cannot use, such as pages behind auth or internal tooling. Capabilities match
> by their dispatch path (`/api/capabilities/**`).

### Vite options that matter

| Option | Description |
| --- | --- |
| `base` | Serve the app under a sub-path. See [Sub-Path Deploys](/docs/deployment#sub-path-deploys) |

---

## `defineApp()` — the route manifest

```ts [src/routes.ts]
import { defineApp, group, route } from "@pracht/core";

export const app = defineApp({
  routes: [route("/", "./routes/home.tsx", { render: "ssg" })],
});
```

| Field | Type | Description |
| --- | --- | --- |
| `routes` | (RouteDefinition \| GroupDefinition)[] | **Required.** The route tree. See [Routing](/docs/routing) |
| `shells` | Record\<string, ModuleRef\> | Named [shell](/docs/shells) modules |
| `middleware` | Record\<string, ModuleRef\> | Named [middleware](/docs/middleware) modules |
| `capabilities` | Record\<string, ModuleRef\> | Named [capabilities](/docs/capabilities), e.g. `{ "notes.search": () => import("./capabilities/notes-search.ts") }`. Server-only and private unless they declare `expose` |
| `notFound` | ModuleRef \| NotFoundConfig | The [404 page](/docs/data-loading#custom-404-page) |
| `api` | ApiConfig | App-wide API policy — see below |
| `agents` | PrachtAgentsConfig | [Agent trust](/docs/agent-trust): Web Bot Auth policy and keys, the destructive-capability confirmation flow, and the [remote MCP endpoint](/docs/capabilities#remote-mcp-tools-for-agents-without-a-browser) with its optional OAuth resource-server config. Serializable data and module references only |
| `constraints` | RouteConstraint[] | Declarative invariants over the resolved graph, enforced by `pracht verify`. See [Coding Agents](/docs/coding-agents#constraints) |
| `viewTransitions` | boolean | Animate client navigations with the View Transitions API, and full page loads (islands and `hydration: "none"` routes) as cross-document transitions. See [View Transitions](/docs/recipes/view-transitions) |
| `loaderTimeoutMs` | number | Per-request budget in milliseconds for the `signal` passed to middleware, loaders, and API handlers; it also aborts when the client disconnects. Default `30000`. Applies to SSG/ISG prerendering too, so a short budget can fail the build. See [Data Loading](/docs/data-loading#signal) |

### `api`

| Field | Default | Description |
| --- | --- | --- |
| `middleware` | `[]` | Named middleware applied to every API route |
| `requireSameOrigin` | `true` | Reject cross-origin state-changing API requests and WebSocket upgrades with `403`. Set `false` only if your middleware does its own CSRF protection. See [Same-Origin Protection](/docs/api-routes#same-origin-protection-csrf) |

### Route and group meta

`route()` and `group()` take the same meta fields — see the
[RouteMeta table](/docs/routing#routepath-file-meta). A group's meta cascades to
its children, and a child's own meta wins.

---

## Where the rest lives

| Configuration | Documented in |
| --- | --- |
| Adapter options (`createContextFrom`, `basePathStripped`, compression, …) | [Adapters](/docs/adapters) |
| `prachtContent()` and `defineCollection()` | [Content Collections](/docs/content) |
| `prachtImage()` and image loaders | [Images](/docs/images) |
| `prachtOpenApi()` | [OpenAPI](/docs/openapi) |
| `defineI18n()` and dictionaries | [i18n Reference](/docs/reference/i18n) |
| `defineFont()` | [Fonts](/docs/fonts) |
| CLI flags | [CLI](/docs/cli) |
