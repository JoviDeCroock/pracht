---
title: Content Security Policy
lead: Add a focused Content Security Policy with route or shell headers, then verify it against dynamic and prerendered pages.
breadcrumb: CSP
prev:
  href: /docs/recipes/auth
  title: Authentication
next:
  href: /docs/recipes/forms
  title: Forms
---

## Starter Policy

For an app that only uses same-origin scripts, styles, images, fonts, and API
calls, put the policy on the shell that wraps those pages:

```ts [src/shells/public.tsx]
export function headers() {
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
blocking cross-origin script execution and plugin embeds by default.

## Add Origins Deliberately

Only add the external origins your app actually uses:

```ts [src/shells/public.tsx]
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

Avoid `'unsafe-eval'`. Avoid `'unsafe-inline'` unless an audited integration
requires it and the exception is documented.

## Inline Script Entries

Pracht does not require app-authored executable inline scripts for normal page
rendering. If a route `head()` returns inline `script` entries, such as JSON-LD,
test that route with the CSP enabled and prefer route-specific hashes for exact
inline content.

## SSG/ISG Header Safety

Headers for SSG and ISG pages are copied into the prerender header manifest so
adapters can apply them to static HTML. That manifest is public static output
for some adapters, so it must only contain public, replay-safe headers.

Pracht fails SSG/ISG prerendering when document headers include dangerous names
such as `Set-Cookie`, `Authorization`, `Proxy-Authenticate`,
`WWW-Authenticate`, or secret-shaped custom `x-*` headers. Set cookies from API
routes, middleware `Response`s, or SSR-only routes instead.

## Verify

- Load an SSR page and an SSG/ISG page in a browser.
- Navigate client-side between routes.
- Check the console for CSP violations.
- Keep `script-src` and `connect-src` as small as possible.
