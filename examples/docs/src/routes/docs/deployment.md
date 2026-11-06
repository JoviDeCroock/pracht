---
title: Deployment
lead: Pick an adapter, build, and deploy to Cloudflare Workers, Vercel, Netlify, Node.js, or a static host.
---

## Choose an adapter

Pass one adapter to `pracht()` in `vite.config.ts`. Each section below has the config and commands for one target; [Adapters](/docs/adapters) lists what each one emits and every option.

| Target | Package | Runs as |
| --- | --- | --- |
| [Node.js](#nodejs) | `@pracht/adapter-node` | A standalone `node:http` server |
| [Cloudflare Workers](#cloudflare-workers) | `@pracht/adapter-cloudflare` | A Worker with bindings, Durable Objects, and WebSockets |
| [Vercel](#vercel) | `@pracht/adapter-vercel` | An Edge Function; ISG routes use Vercel ISR |
| [Netlify](#netlify) | `@pracht/adapter-netlify` | A Functions v2 handler; ISG uses Netlify's CDN cache |
| [Static hosts](#static-hosts) | `@pracht/adapter-static` | Plain files; `ssg` and loaderless `spa` routes only |

Every adapter except static supports all render modes, middleware, and API routes. `pracht preview` builds the app and serves it locally the way the Node, Cloudflare, and static targets run it.

## Node on the build image

Run `pracht build` on **Node 22.18 or newer**. Hosted build images often default to something older: Cloudflare Pages and Netlify read `.nvmrc`, and Vercel reads `engines.node` from `package.json`. `create-pracht` writes both; add them yourself when migrating an existing project.

```txt [.nvmrc]
22
```

## Node.js

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
pracht build
node dist/server/server.js     # listens on $PORT, default 3000
```

Set `canonicalOrigin` so request URLs never come from the `Host` header; without it the server logs a warning at startup. Proxy, body-size, compression, and shutdown options are in the [adapter reference](/docs/adapters#nodejs).

## Cloudflare Workers

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";

export default defineConfig({
  plugins: [pracht({ adapter: cloudflareAdapter() })],
});
```

```jsonc [wrangler.jsonc]
{
  "name": "my-app",
  "compatibility_date": "2026-04-06",
  "assets": {
    "binding": "ASSETS",
    "html_handling": "drop-trailing-slash",
    "run_worker_first": ["/*", "!/assets/*"],
  },
}
```

```sh
pracht preview          # build, then run wrangler dev locally
pracht build
npx wrangler deploy
```

Configure bindings (KV, D1, R2) in `wrangler.jsonc`; loaders and API routes read them from `context.env`. `pracht preview` reads local secrets from a gitignored `.dev.vars` file, and production secrets come from `wrangler secret`.

The [adapter reference](/docs/adapters#cloudflare-workers) covers what the `assets` keys do, named environments, ISG caching, Durable Objects, cron and queue handlers, and deploying with Void.

## Vercel

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { vercelAdapter } from "@pracht/adapter-vercel";

export default defineConfig({
  plugins: [pracht({ adapter: vercelAdapter() })],
});
```

```sh
pracht build
npx vercel deploy --prebuilt
```

For webhook revalidation, set `PRACHT_REVALIDATE_TOKEN` at build time, not only at runtime. `pracht preview` does not emulate Vercel; use `vercel build` and `vercel dev`. See the [adapter reference](/docs/adapters#vercel).

## Netlify

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
pracht build && netlify dev        # run the build locally
netlify deploy --build --prod
```

`pracht preview` does not emulate Netlify's Functions or CDN cache, so run `netlify dev` after building. Caching and `excludedPath` are in the [adapter reference](/docs/adapters#netlify-functions).

## Static hosts

Deploy as plain files to GitHub Pages, S3, nginx, Netlify, or any file host when every route is `ssg` (or loaderless `spa` with full hydration) and the app has no middleware, API routes, or exposed capabilities.

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { staticAdapter } from "@pracht/adapter-static";

export default defineConfig({
  plugins: [pracht({ adapter: staticAdapter() })],
});
```

```sh
pracht build      # dist/client/ is the whole deployment
pracht preview    # build, then serve dist/client/ the way a static host does
```

When something needs a server, the build fails and lists every offender. It writes the `notFound` page as `404.html`, and with `staticAdapter({ fallback: "200.html" })` also an SPA fallback for hosts that rewrite unknown URLs. Host requirements are in the [adapter reference](/docs/adapters#static-export).

## Tabs open across a deploy

When a deploy removes the previous build's hashed chunks, open tabs point at files that no longer exist. If a client navigation cannot load the next route's chunk, the router loads that URL as a full page, which picks up the new build.

Route chunks need no `vite:preloadError` listener. A listener that calls `location.reload()` reloads the page the visitor is leaving rather than the link they clicked.

## Sub-path deploys

Set Vite's `base` to serve the app under a path rather than an origin root, such as a GitHub Pages *project* site (`https://user.github.io/my-project/`), an S3 key prefix, or a reverse-proxy mount point:

```ts [vite.config.ts]
export default defineConfig({
  base: "/my-project/",
  plugins: [pracht({ adapter: nodeAdapter() })],
});
```

The output tree does not change: `dist/client/` still contains `about/index.html`, and you upload the whole directory to the sub-path. Every URL the build emits includes the base: scripts, stylesheets, route-state fetches, `llms.txt` links, and hrefs from `<Link route>`, `href()`, `useNavigate()`, and `prefetch()`.

Route paths in the manifest stay base-free, while `useLocation()` reports the URL as the visitor sees it, base included. `pracht dev` and `pracht preview` serve the app under the same base and redirect a bare `/my-project` to `/my-project/`.

### Hand-written links do not get the base

`<a href="/about">` means the origin root in HTML, and pracht does not rewrite it. Use `<Link route="about">` or `href("about")` for internal navigation and the base is applied for you.

For paths you write by hand, such as a root-absolute `<a href>`, a `fetch()` to your own endpoint, or an asset URL built at runtime, move the path across the base with these helpers:

```ts
import { PRACHT_BASE, withBase, stripBase } from "@pracht/core";

PRACHT_BASE; // "/my-project/" — always leading and trailing slashes, "/" by default
withBase("/about"); // "/my-project/about"   route path → URL path
stripBase("/my-project/about"); // "/about"  URL path → route path
stripBase("/elsewhere"); // null — outside the base, so not this app
```

At the default base of `/` both functions return their input unchanged, so code written this way keeps working when the app moves under a sub-path.

### Base values that are build errors

Use `/` or a root-absolute path such as `/my-project/`.

| Value | Why it fails |
| --- | --- |
| `https://cdn.example.com/`, `//cdn…` | A CDN base only relocates assets; documents and the route-state tree stay at the origin root |
| `"./"`, `""` | A document-relative base makes nested pages resolve assets beneath their own directory |

### Behind a proxy that strips the base

The Node adapter expects the base to still be on the forwarded path. When a trusted proxy removes it first, set `basePathStripped`; the proxy then owns the trailing-slash redirect:

```ts [vite.config.ts]
pracht({ adapter: nodeAdapter({ basePathStripped: true }) });
```

pracht cannot detect this itself: a forwarded `/my-project/about` could be the base plus `/about`, or a route whose own path is `/my-project/about`.

Cloudflare, Netlify, and Vercel deployments always keep the base and handle the redirect themselves.

### Static hosts

The [static adapter](/docs/adapters#static-export) requires `/` or a root-absolute base. `pracht preview` answers anything outside the base with a 404, matching a correctly configured host.
