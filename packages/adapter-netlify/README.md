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
the exclusion only avoids a function invocation. Prefix-shaped exclusions are
also omitted from the generated function bundle, so large static asset trees do
not count against Netlify's function size limit.

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
- Cached SSG and ISG HTML uses `Netlify-Vary:
  query=_data,header=x-pracht-route-state-request`, so both route-state
  transports keep their own cache variant while unrelated query parameters
  collapse onto the pathname entry. Netlify combines that key with the
  standard `Vary: Accept` header Pracht emits for Markdown-capable routes;
  `Accept` is not a valid `Netlify-Vary` directive. A custom `Netlify-Vary`
  header takes precedence.
- Cacheable webhook-revalidated ISG responses carry per-path cache tags, even
  when the route provides a custom cache policy.
  `POST /__pracht/revalidate` authenticates with `PRACHT_REVALIDATE_TOKEN` and
  purges those tags through Netlify's Functions API.
- Shared ISG renders use a sanitized request and an allowlisted Netlify
  context. Visitor cookies, authorization, query strings, bodies, IP address,
  geolocation, request IDs, and arbitrary request-local context cannot enter
  cached HTML. Deployment-wide site/server metadata and `waitUntil()` remain
  available; attempts to mutate cookies fail closed. Because `Accept-Language`
  and geolocation are stripped too, an ISG route that picks a locale from the
  request caches its default-locale output for every visitor — put the locale
  in the path (`/en/pricing`) if an ISG page must localize.
- SSR and API responses that declare `Cache-Control: public` are promoted into
  the durable cache with the route-state `Netlify-Vary` entries. Promotion
  fails closed: responses to route-state-shaped requests and responses that
  are not shareable (`Set-Cookie`, `Vary: Cookie`/`Authorization`) get
  `Netlify-CDN-Cache-Control: private` instead, so one visitor's render can
  never become the CDN's answer for everyone. An explicit
  `Netlify-CDN-Cache-Control` header stays fully user-owned.

Tune the cache windows when needed:

```ts
netlifyAdapter({
  staleWhileRevalidate: 86_400,
  staticMaxAge: 604_800,
});
```
