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

Everything below is optional. The defaults are the conventions a `create-pracht`
app already follows, so most apps pass only an `adapter`.

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
| `additionalExtensions` | `[]` | Extra dot-prefixed route/shell extensions to discover, e.g. `[".vue"]`. Register the transforming plugin separately; pracht only discovers the modules. `.tsrx` is discovered without configuration |

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
| `budgets` | `{}` | Per-route gzip client-JS budgets, e.g. `{ "*": "120kb", "/dashboard": "200kb" }`. `"*"` applies everywhere; explicit paths override it. Exceeding one fails the build unless you pass `pracht build --no-budget-fail` |
| `precompileSsrJsx` | `false` | Precompile safe Preact JSX DOM subtrees in SSR/SSG server bundles. Client bundles keep the normal transform for hydration |
| `envSafety` | `{}` (enabled) | Fail the build when a production client chunk references a non-public env var. `{ allow: ["NAME"] }` permits specific ones; `false` disables the check. See [Environment Variables](/docs/env) |

### Client bundle

`client` switches off router features so they are compiled out of the client
bundle. Every feature defaults to `true`. Turn one off only when the app really
does not use it — the router then silently stops honouring the corresponding
route options and `<Link>` props.

| Option | Default | Description |
| --- | --- | --- |
| `client.prefetch` | `true` | JS [prefetching](/docs/prefetching#shipping-less-javascript) driven by `route({ prefetch })` and `<Link prefetch>`. Off also drops the separate prefetch chunk and makes `prefetch()` a no-op |

An unknown key here is an error rather than a silent no-op, so a typo cannot
quietly ship the feature you meant to remove.

### Agent surfaces

| Option | Default | Description |
| --- | --- | --- |
| `llmsTxt` | `false` | Emit [`llms.txt`](/docs/llms) from the resolved app graph |
| `llmsTxt.title` | package `name` | H1 title |
| `llmsTxt.description` | package `description` | Blockquote summary under the title; omitted when neither is set |
| `llmsTxt.origin` | *(unset)* | Origin prepended to every link, e.g. `"https://example.com"`. Links stay root-relative when omitted |
| `llmsTxt.include` | `["pages", "api", "capabilities"]` | Which sections to emit |
| `llmsTxt.exclude` | `[]` | Path patterns to leave out, using the same segment globs as `constraints` (`*` is one segment, trailing `**` is the rest) |

> [!NOTE]
> `llms.txt` invites agents to fetch every URL it lists. Exclude anything an
> anonymous agent cannot use — pages behind auth middleware, internal tooling,
> deliberate error routes. Capabilities are matched by their dispatch path
> (`/api/capabilities/**`).

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
| `notFound` | ModuleRef \| NotFoundConfig | The [404 page](/docs/data-loading#custom-404-page). Deliberately not a route |
| `api` | ApiConfig | App-wide API policy — see below |
| `agents` | PrachtAgentsConfig | [Agent trust](/docs/agent-trust): Web Bot Auth policy and keys, and the destructive-capability confirmation flow. Serializable data only |
| `constraints` | RouteConstraint[] | Declarative invariants over the resolved graph, enforced by `pracht verify`. See [Agent Workflow](/docs/agent-workflow) |
| `viewTransitions` | boolean | Enable the View Transitions API for every client navigation by default. See [View Transitions](/docs/recipes/view-transitions) |

### `api`

| Field | Default | Description |
| --- | --- | --- |
| `middleware` | `[]` | Named middleware applied to every API route |
| `requireSameOrigin` | `true` | Reject state-changing API requests (POST/PUT/PATCH/DELETE) unless the browser signals an exact same-origin fetch, or Origin/Referer matches the request URL's origin. `same-site` is deliberately not accepted, because sibling subdomains can be attacker-controlled. Set `false` only if your middleware implements its own CSRF protection |

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
