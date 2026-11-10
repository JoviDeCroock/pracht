---
title: Vercel and Netlify
lead: Build output, options, and ISG caching for `@pracht/adapter-vercel` and `@pracht/adapter-netlify`.
---

Both adapters run SSR and API routes in the platform's functions and map ISG onto its CDN cache.

## Vercel

The adapter writes Vercel's Build Output API v3: SSG pages as static files, SSR and API routes in an Edge Function, and each ISG route in its own Node Serverless Function, where Vercel supports ISR.

| Option | Default | Effect |
| --- | --- | --- |
| `regions` | Vercel's default | Edge Function regions; `"all"` keeps it global while ISG functions use the project's default Serverless region |
| `functionName` | `"render"` | Edge Function name; change it if an ISG route collides with it |
| `createContextFrom` | none | Module exporting `createContext` (see [Context factory](/docs/adapters#context-factory)) |

### Build output

```
.vercel/
  output/
    config.json    // routes, rewrites, headers
    static/        // SSG pages, plus /assets/ files cached as immutable
    functions/
      render.func/ // Edge Function for SSR/API routes and webhook bridge
      pricing.func/ // Serverless Function for one ISG route
      pricing.prerender-config.json
```

For webhook revalidation, set `PRACHT_REVALIDATE_TOKEN` **at build time**. Vercel embeds it in each ISG route's prerender config, so a token set only at runtime cannot bypass the cache until you rebuild. Time-only ISR does not need it.

Each SSG or ISG page uses one of the 2,048 routes Vercel allows per Hobby or Pro deployment; `pracht build` warns near the limit.

A custom Vercel server entry must export `nodeListener`, built with `createVercelNodeListener(handle)`, so the ISG functions can run the same handler.

## Netlify Functions

The adapter emits a Functions v2 handler and maps ISG to Netlify's durable CDN cache.

| Option | Default | Effect |
| --- | --- | --- |
| `excludedPath` | none | Extra static prefixes Netlify serves without the function; never list page URLs |
| `staleWhileRevalidate` | one year | Seconds stale ISG output is served while Netlify refreshes it; `0` disables |
| `staticMaxAge` | one year | CDN lifetime of SSG documents; `0` for no freshness |
| `functionName` | `"pracht"` | Generated function name |
| `functionsDir` | `netlify/functions` | Where the function wrapper is written |
| `createContextFrom` | none | Module exporting `createContext` (see [Context factory](/docs/adapters#context-factory)) |

The function serves every page URL. `/assets/*`, `/_pracht/*`, and `excludedPath` prefixes bypass it; the build writes their immutable caching and security headers to `dist/client/_headers`. A `public/_headers` file of your own replaces it, and the build warns.

### Caching and revalidation

- SSG documents are cached durably on Netlify's CDN.
- ISG routes use their revalidation window as the CDN `max-age` and serve the stale page while a fresh render runs. Authenticated calls to `/__pracht/revalidate` purge a page's cache tag.
- SSR and API responses with `Cache-Control: public` are cached on the CDN too, unless they set a cookie or vary on `Cookie` or `Authorization`. Set `Netlify-CDN-Cache-Control` to control that; otherwise a `public` `Cache-Control` is copied into it.
- On SSG and ISG pages, your own `Cache-Control`, `CDN-Cache-Control`, or `Netlify-CDN-Cache-Control` overrides these defaults.
- A non-canonical ISG URL redirects to the canonical spelling, so one copy is cached, and unrelated query parameters share its entry. A custom `Netlify-Vary` header replaces pracht's default key.
