# Content Security Policy Recipe

Pracht does not set a Content Security Policy by default because a correct CSP
depends on each app's script, style, image, font, analytics, and API origins.
Use route or shell `headers()` exports to add one deliberately.

## Starter Policy

For an app that only loads first-party assets and calls first-party APIs, start
with:

```ts
// src/shells/public.tsx
import type { HeadersArgs } from "@pracht/core";

export function headers(_args: HeadersArgs) {
  return {
    "content-security-policy": [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'self'",
      "form-action 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
    ].join("; "),
  };
}
```

This allows Pracht's generated module script and same-origin assets while
blocking plugin/object embeds and cross-origin scripts by default.

## Add Only The Origins You Use

If your app calls an API on another origin or loads assets from a CDN, add those
origins to the matching directive:

```ts
export function headers() {
  return {
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: https://images.example.com",
      "font-src 'self' https://fonts.example.com",
      "connect-src 'self' https://api.example.com",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'self'",
      "form-action 'self'",
    ].join("; "),
  };
}
```

Avoid `'unsafe-eval'`. Avoid `'unsafe-inline'` unless an audited dependency or
legacy integration needs it and the exception is documented.

## Inline Script Entries

Normal Pracht page rendering and hydration do not require executable inline
scripts from application code. If your route `head()` returns `script` entries
for JSON-LD or another inline format, test the route with your CSP enabled and
prefer hashes or a route-specific policy for the exact inline content.

For third-party analytics, prefer loading the script from an explicit origin and
keep the vendor's collection endpoint in `connect-src`.

## SSG/ISG Header Safety

Document headers for SSG and ISG pages are copied into the prerender header
manifest so adapters can apply them to static HTML. That manifest is public
static output for some adapters, so it must only contain public, replay-safe
headers.

Pracht fails SSG/ISG prerendering when a document response includes dangerous
headers such as `Set-Cookie`, `Authorization`, `Proxy-Authenticate`,
`WWW-Authenticate`, or secret-shaped custom `x-*` headers. Set cookies from API
routes, middleware `Response`s, or SSR-only routes instead.

## Deployment Checklist

- Verify the final CSP in a browser, including client navigation.
- Check both dynamic HTML and prerendered SSG/ISG HTML.
- Keep `script-src` and `connect-src` as small as possible.
- Do not add HSTS preload directives until the domain is permanently HTTPS-only.
