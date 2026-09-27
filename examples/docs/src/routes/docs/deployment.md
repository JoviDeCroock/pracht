---
title: Deployment
lead: pracht apps deploy anywhere via platform adapters. Pick one, build, and ship; the Adapters reference covers each platform's options in depth.
breadcrumb: Deployment
prev:
  href: /docs/cli
  title: CLI
next:
  href: /docs/adapters
  title: Adapters Reference
---

## Node on the build image

The machine that runs `pracht build` needs **Node 22.18 or newer**. Hosted build
images often default to something older: Cloudflare Pages and Netlify read
`.nvmrc`, and Vercel reads `engines.node` from `package.json`. `create-pracht`
writes both; add them yourself when migrating an existing project.

```txt [.nvmrc]
22
```

## Node.js

The default adapter. Generates a standalone Node.js server with static file serving and ISG support.

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { nodeAdapter } from "@pracht/adapter-node";

export default defineConfig({
  plugins: [
    pracht({
      adapter: nodeAdapter({
        canonicalOrigin: "https://app.example.com",
      }),
    }),
  ],
});
```

```sh
# Build and run
pracht build
pracht preview
# or: node dist/server/server.js
```

Set `canonicalOrigin` so request URLs never come from the `Host` header.
Proxy, body-size, and compression options are in the
[adapter reference](/docs/adapters#nodejs).

---

## Cloudflare Workers

Deploys as a Cloudflare Worker with static assets served via the `ASSETS` binding.

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";

export default defineConfig({
  plugins: [pracht({ adapter: cloudflareAdapter() })],
});
```

```sh
# Build and deploy
pracht build
wrangler deploy
```

Configure bindings (KV, D1, R2) in `wrangler.jsonc`; loaders and API routes
read them from `context.env`. `pracht preview` runs Wrangler locally and reads
local secrets from a gitignored `.dev.vars` file.

Durable Objects, Workflows, queue and cron handlers, and ISG caching are
covered in the [adapter reference](/docs/adapters#exporting-bindings-and-event-handlers).

---

## Vercel

Deploys with Vercel's Build Output API: static SSG pages, an Edge Function for
SSR and API routes, and Vercel's native ISR for ISG routes.

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { vercelAdapter } from "@pracht/adapter-vercel";

export default defineConfig({
  plugins: [pracht({ adapter: vercelAdapter() })],
});
```

```sh
# Build and deploy
pracht build
vercel deploy --prebuilt
```

For webhook revalidation, set `PRACHT_REVALIDATE_TOKEN` at build time, not only
at runtime. `pracht preview` doesn't emulate Vercel; use `vercel build` and
`vercel dev`. See the [adapter reference](/docs/adapters#vercel).

---

## Netlify

Deploys through a Netlify Functions v2 handler, with SSG and ISG pages stored in
Netlify's durable CDN cache.

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { netlifyAdapter } from "@pracht/adapter-netlify";

export default defineConfig({
  plugins: [pracht({ adapter: netlifyAdapter() })],
});
```

```toml [netlify.toml]
[build]
  command = "pnpm build"
  publish = "dist/client"

[functions]
  directory = "netlify/functions"
```

```sh
pracht build && netlify dev
netlify deploy --build --prod
```

Add extra static prefixes with `netlifyAdapter({ excludedPath: [...] })`, but
never exclude page URLs. `pracht preview` doesn't emulate Netlify; use
`netlify dev` after building. See the
[adapter reference](/docs/adapters#netlify-functions).

---

## Static hosts

An app whose routes are all `ssg` (or loaderless `spa` with full hydration),
with no middleware, API routes, or exposed capabilities, can deploy as plain
files with `@pracht/adapter-static` — GitHub Pages, S3, nginx, Netlify, any file
host.

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { staticAdapter } from "@pracht/adapter-static";

export default defineConfig({
  plugins: [pracht({ adapter: staticAdapter() })],
});
```

```sh
# Build and preview
pracht build      # dist/client/ is the whole deployment
pracht preview
```

The build fails with a list of offenders when something needs a server. It
writes the `notFound` page as `404.html` and, with
`staticAdapter({ fallback: "200.html" })`, an SPA fallback for hosts that can
rewrite unknown URLs. See the [adapter reference](/docs/adapters#static-export)
for host configuration.

---

## Sub-Path Deploys

Set Vite's `base` to serve the app under a path rather than an origin root — a
GitHub Pages *project* site (`https://user.github.io/my-project/`), an S3 key
prefix, a reverse-proxy mount point:

```ts [vite.config.ts]
export default defineConfig({
  base: "/my-project/",
  plugins: [pracht({ adapter: nodeAdapter() })],
});
```

The output tree doesn't change: `dist/client/` still contains
`about/index.html`, and you upload the whole directory to the sub-path. Every
URL the build emits includes the base: scripts, stylesheets, route-state
fetches, `llms.txt` links, and hrefs from `<Link route>`, `href()`,
`useNavigate()`, and `prefetch()`.

Route paths in the manifest stay base-free, while `useLocation()` reports the
URL as the visitor sees it, base included. `pracht dev` and `pracht preview`
serve the app under the same base, and redirect a bare `/my-project` to
`/my-project/`.

### Hand-written links do not get the base

`<a href="/about">` means the origin root in HTML, and pracht does not rewrite
it — the same rule as Next's `basePath` and SvelteKit's `base`. Use
`<Link route="about">` or `href("about")` for internal navigation and the base
is applied for you.

For the paths you do write by hand — a root-absolute `<a href>`, a `fetch()` to
your own endpoint, an asset URL built at runtime — three helpers move a path
across the base:

```ts
import { PRACHT_BASE, withBase, stripBase } from "@pracht/core";

PRACHT_BASE; // "/my-project/" — always leading and trailing slashes, "/" by default
withBase("/about"); // "/my-project/about"   route path → URL path
stripBase("/my-project/about"); // "/about"  URL path → route path
stripBase("/elsewhere"); // null — outside the base, so not this app
```

At the default base of `/` both functions are the identity, so code written this
way costs nothing until the app moves under a sub-path.

### Base values that are build errors

Use `/` or a root-absolute path such as `/my-project/`.

| Value | Why it fails |
| --- | --- |
| `https://cdn.example.com/`, `//cdn…` | A CDN base only relocates assets; documents and the route-state tree stay at the origin root |
| `"./"`, `""` | A document-relative base makes nested pages resolve assets beneath their own directory |

### Behind a proxy that strips the base

The Node adapter expects the base to still be on the forwarded path. When a
trusted proxy removes it first, say so; the proxy then owns the trailing-slash
redirect:

```ts [vite.config.ts]
pracht({ adapter: nodeAdapter({ basePathStripped: true }) });
```

Pracht can't detect this: a forwarded `/my-project/about` could be the base
plus `/about`, or a route whose own path is `/my-project/about`.

Cloudflare, Netlify, and Vercel deployments always keep the base and handle the
redirect themselves.

### Static hosts

The [static adapter](/docs/adapters#static-export) requires `/` or a
root-absolute base. `pracht preview` answers anything outside the base with a
404, matching what a correctly configured host does.
