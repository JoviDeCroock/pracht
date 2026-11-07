---
title: Pages router
lead: Derive routes, shells, middleware, and capabilities from files in `src/pages/` instead of writing a `src/routes.ts` manifest.
---

Set `pagesDir` instead of writing a manifest, and pracht derives routes from
files:

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [pracht({ pagesDir: "/src/pages" })],
});
```

The plugin generates a `defineApp()` manifest from your files, so both routers
share one runtime. `appFile` is ignored while `pagesDir` is set.

## What the pages router supports and how

| Feature                                                                   | Where it comes from                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Routes, dynamic and catch-all segments, `getStaticPaths`                  | [File names](#file-conventions)                                           |
| Render mode, hydration, ISG, route-scoped WebMCP tools                    | [Page exports](#page-exports)                                             |
| Shells                                                                    | [`_app.tsx`](#shells-via-apptsx) per directory                            |
| Middleware                                                                | One root [`_middleware.ts`](#middleware-via-middlewarets)                 |
| Capabilities: HTTP, remote MCP, `<Form capability>`, `pracht eval`        | Modules in [`src/capabilities/`](#capabilities-via-srccapabilities)       |
| `agents` and `constraints`                                                | [`_app.config.ts`](#app-config-via-appconfigts)                           |
| API routes                                                                | `src/api/`, as with the manifest router                                   |

What still requires an explicit manifest:

- **Per-route middleware assignment.** `_middleware.ts` runs on every page
  route.
- **Per-route shell overrides.** The directory chooses the shell.
- **Named middleware** beyond the one file, and capabilities outside
  `src/capabilities/`.
- **Path prefixes and explicit route ids.**
- **Webhook and combined ISG policies.** Pages ISG is time-based only.

To get these, [eject](#ejecting-to-explicit-manifest) to a manifest at any
time.

## File conventions

| File                                  | Result                                                       |
| ------------------------------------- | ------------------------------------------------------------ |
| `pages/index.tsx`                     | `/`                                                          |
| `pages/about.tsx`                     | `/about`                                                     |
| `pages/blog/index.tsx`                | `/blog`                                                      |
| `pages/blog/[slug].tsx`               | `/blog/:slug`                                                |
| `pages/[...path].tsx`                 | `/*`                                                         |
| `pages/404.tsx`                       | [Not-found page](/docs/routing#not-found-page), with no URL of its own |
| `pages/_app.tsx`, `pages/blog/_app.tsx` | Shells                                                     |
| `pages/_middleware.ts`                | Middleware (pages root only)                                 |
| `pages/_app.config.ts`                | App config (pages root only)                                 |
| `pages/_root.tsx`                     | [App root](/docs/shells#the-app-root) (pages root only)      |
| `pages/_lib.ts`, `pages/_components/` | Ignored; use underscore names for helpers                    |
| `pages/about.test.tsx`                | Ignored                                                      |

Static routes match before dynamic ones, and dynamic before catch-all.

## Page exports

```tsx [src/pages/pricing.tsx]
export const RENDER_MODE = "isg";
export const REVALIDATE = 3600;
export const CAPABILITIES = ["notes.search"];

export default function Pricing() {
  return <div>Pricing</div>;
}
```

| Export         | Values                                          | Default                                     |
| -------------- | ----------------------------------------------- | ------------------------------------------- |
| `RENDER_MODE`  | `"ssr"`, `"ssg"`, `"isg"`, `"spa"`              | `"ssr"`, or the `pagesDefaultRender` option |
| `HYDRATION`    | `"full"`, `"islands"`, `"none"`                 | `"full"`                                    |
| `REVALIDATE`   | Seconds, a positive integer; required for ISG   | None                                        |
| `CAPABILITIES` | Capability names to expose as WebMCP page tools | None                                        |
| `STREAMING`    | `true` to [stream the document](/docs/data-loading#streaming-the-document) | `false`          |

Write each value as a literal. `CAPABILITIES` is not allowed on `_app.tsx`,
`404.tsx`, or a `HYDRATION = "none"` page.

## Shells via `_app.tsx`

`pages/_app.tsx` exports a `Shell` and becomes the shell `"pages"`. An
`_app.tsx` in a subdirectory owns that subtree: `pages/blog/_app.tsx` becomes
`"pages:blog"` and wraps `/blog` and `/blog/:slug`.

The nearest `_app` is a route's only shell; shells do not nest, so a directory
shell supplies its own chrome, `head()`, and `headers()`. An `_app` can export a
[shell `loader`](/docs/shells#shell-data).

## Middleware via `_middleware.ts`

On a serverful adapter, `pages/_middleware.ts` exports a
[`MiddlewareFn`](/docs/middleware) that runs on every page route. Scaffold it
with `pracht generate middleware --name _middleware`:

```ts [src/pages/_middleware.ts]
import { redirect, stripBase, type MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async ({ request, url }, next) => {
  if (stripBase(url.pathname) === "/legacy") return redirect("/about", { request });
  return next();
};
```

- Compare paths with `stripBase()`; `url.pathname` includes Vite's `base`.
- It does not run for API routes; guard those with
  [higher-order functions](/docs/middleware#without-a-manifest-higher-order-functions).
- Prerendered pages see a build-time request, so gate by session only on `ssr`
  and `spa` pages.

## Capabilities via `src/capabilities/`

Every module in `src/capabilities/` is registered as a
[capability](/docs/capabilities). Scaffold one with
`pracht generate capability --name notes.search --expose http,mcp --description "Find notes."`.

A capability's `name` must match its file name with dots as hyphens:
`notes.search` lives in `notes-search.ts`. Without a `name`, the file stem is
used. To expose one as a WebMCP tool, list it in a page's
[`CAPABILITIES`](#page-exports) export.

## App config via `_app.config.ts`

Export `agents` and `constraints` from `src/pages/_app.config.ts`; the
generated manifest passes them to `defineApp()` unchanged:

```ts [src/pages/_app.config.ts]
import type { PrachtAgentsConfig } from "@pracht/core";

export const agents: PrachtAgentsConfig = {
  webBotAuth: { policy: "observe", keys: [{ x: "…", agent: "acme-agent.example" }] },
  mcp: { serverInfo: { name: "my-app", version: "1.0.0" } },
};
```

Only these two named exports are read, and the file never enters a client
bundle.

## Ejecting to explicit manifest

Generate `src/routes.ts` from the current pages once:

```ts
import { generateRoutesFile } from "@pracht/vite-plugin/pages-router";

generateRoutesFile("src/pages", "src/routes.ts", {
  pagesDir: "src/pages",
  pagesDefaultRender: "ssr",
  capabilitiesDir: "src/capabilities", // pass null to register none
});
```

Then remove `pagesDir` and point discovery at the existing files:

```ts [vite.config.ts]
pracht({
  appFile: "/src/routes.ts",
  routesDir: "/src/pages",
  shellsDir: "/src/pages",
  middlewareDir: "/src/pages",
});
```

Keep the generated `__PRACHT_EJECTED_PAGES_LAYOUT__ = true` export while `_app`
or `_middleware` files remain in `src/pages`; `pracht verify` warns if it is
missing.
