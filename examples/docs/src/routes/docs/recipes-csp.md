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

## Framework-Generated Styles

`defineFont()`, `pracht({ inlineCss: true })`, and
`defineApp({ viewTransitions: true })` emit inline style elements.
For SSR, return a request-specific `styleNonce` from the shell head and use the
same value in `style-src`:

```ts [src/shells/public.tsx]
export function head({ context }) {
  return { fonts: [inter], styleNonce: context.cspNonce };
}

export function headers({ context }) {
  return {
    "content-security-policy": `default-src 'self'; style-src 'self' 'nonce-${context.cspNonce}'; font-src 'self'`,
  };
}
```

`fontNonce` overrides the nonce for fonts only; prefer `styleNonce`. SSG/ISG
output cannot reuse a request nonce, so keep linked CSS and use a stable hash
or external stylesheet policy for static documents. The `viewTransitions` style
never changes, so allow it with
`'sha256-SREix9zPMZHrSuo8zRSjb672r1gsHIh96MJuaZq6iJo='`.

## Framework-Generated Scripts

Buffered pages need no executable inline scripts. Streaming routes
(`streaming: true`) emit inline scripts for deferred data and boundary swaps,
and routes that opt into `speculation` emit a speculation rules script. Return
the request nonce as `scriptNonce` from the shell head and allow it in
`script-src`:

```ts [src/shells/public.tsx]
export function head({ context }) {
  return { scriptNonce: context.cspNonce, styleNonce: context.cspNonce };
}

export function headers({ context }) {
  return {
    "content-security-policy": `default-src 'self'; script-src 'self' 'nonce-${context.cspNonce}'; style-src 'self' 'nonce-${context.cspNonce}'`,
  };
}
```

## Inline Script Entries

Pracht does not require app-authored executable inline scripts for normal page
rendering. If a route `head()` returns inline `script` entries, such as JSON-LD,
test that route with the CSP enabled and prefer route-specific hashes for exact
inline content.

## SSG/ISG Header Safety

Headers on SSG and ISG pages are stored with the static output, replayed to
every visitor, and public on some adapters. Keep them to public, replay-safe
values.

Prerendering fails if they include `Set-Cookie`, authentication headers such as
`Authorization`, or secret-shaped custom `x-*` headers. Set cookies from API
routes, middleware `Response`s, or SSR-only routes instead.

## Verify

- Load an SSR page and an SSG/ISG page in a browser.
- Navigate client-side between routes.
- Check the console for CSP violations.
- Keep `script-src` and `connect-src` as small as possible.
