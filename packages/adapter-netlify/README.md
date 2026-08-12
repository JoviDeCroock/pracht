# @pracht/adapter-netlify

Netlify Functions v2 adapter for Pracht. It serves SSR and API requests through
a fetch-style function, keeps prerendered HTML available to Markdown content
negotiation and client route-state requests, and maps ISG onto Netlify's durable
CDN cache.

## Install

```bash
npm install @pracht/adapter-netlify
```

## Configure Pracht

```ts
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { netlifyAdapter } from "@pracht/adapter-netlify";

export default defineConfig({
  plugins: [pracht({ adapter: netlifyAdapter() })],
});
```

The build emits `netlify/functions/pracht.mjs`. Its Functions v2 `config`
claims page URLs, excludes Pracht's asset directories, and bundles
`dist/client` plus the generated headers, Markdown, and ISG manifests.

Set Netlify's publish directory to `dist/client`:

```toml
[build]
  command = "npm run build"
  publish = "dist/client"

[functions]
  directory = "netlify/functions"
```

Then deploy normally:

```bash
netlify deploy --build --prod
```

## Static paths

The function must receive page requests so `Accept: text/markdown` and Pracht
route-state fetches are not answered with prerendered HTML. Hashed assets and
`/_pracht/*` bypass the function by default. Add app-specific static prefixes
without bypassing page URLs:

```ts
netlifyAdapter({ excludedPath: ["/content/*", "/images/*"] });
```

Exact static files not excluded from the function are still served correctly;
the exclusion only avoids a function invocation.

## Context

Generated entries can import an app context factory:

```ts
netlifyAdapter({ createContextFrom: "/src/server/context.ts" });
```

The module should export `createContext({ request, context })`. `context` is
Netlify's Functions v2 context, including `waitUntil()` and site/server
metadata.

## SSG and ISG caching

- SSG documents are read from the bundled client output and stored in
  Netlify's durable cache. Atomic deploys invalidate the cached deployment. An
  explicit route cache policy remains authoritative.
- Time-revalidated ISG routes use their Pracht revalidation interval as the
  Netlify CDN `max-age`, with stale-while-revalidate enabled. Cacheable custom
  policies remain authoritative.
- Cached SSG and ISG HTML uses `Netlify-Vary: query=_data`, preserving the
  route-state variant while collapsing unrelated query parameters. A custom
  `Netlify-Vary` header takes precedence.
- Cacheable webhook-revalidated ISG responses carry per-path cache tags, even
  when the route provides a custom cache policy.
  `POST /__pracht/revalidate` authenticates with `PRACHT_REVALIDATE_TOKEN` and
  purges those tags through Netlify's Functions API.
- Shared ISG renders use a sanitized request and an allowlisted Netlify
  context. Visitor cookies, authorization, query strings, bodies, IP address,
  geolocation, request IDs, and arbitrary request-local context cannot enter
  cached HTML. Deployment-wide site/server metadata and `waitUntil()` remain
  available; attempts to mutate cookies fail closed.

Tune the cache windows when needed:

```ts
netlifyAdapter({
  staleWhileRevalidate: 86_400,
  staticMaxAge: 604_800,
});
```
