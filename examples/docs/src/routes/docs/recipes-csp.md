---
title: Content Security Policy
lead: Set a Content Security Policy from route or shell headers, then verify it on dynamic and prerendered pages.
---

This recipe adds a Content Security Policy to every page under a shell, then allows the inline code some pracht features generate.

## 1. Set a starter policy

Return the policy from the `headers()` export of the shell that wraps your pages:

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

Every page under the shell now carries the header. It allows pracht's module script and same-origin assets and blocks cross-origin scripts and plugin embeds.

## 2. Add the origins you use

List only the external origins your app loads from:

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

Avoid `'unsafe-eval'`. Avoid `'unsafe-inline'` unless an audited integration requires it and the exception is documented.

## 3. Allow framework inline code

Some features emit inline `<style>` or `<script>` elements. On SSR routes, allow them with a nonce generated per request. Set it on the context in a middleware:

```ts [src/middleware/csp-nonce.ts]
import type { MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = ({ context }, next) => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  context.cspNonce = btoa(String.fromCharCode(...bytes));
  return next();
};
```

Register it in `defineApp({ middleware })` and add it to the group that uses the shell. See [Middleware](/docs/middleware).

### Framework-generated styles

`defineFont()`, `pracht({ inlineCss: true })`, and `defineApp({ viewTransitions: true })` emit inline `<style>` elements. Return the nonce as `styleNonce` from the shell's `head()` and allow it in `style-src`:

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

`fontNonce` overrides the nonce for font styles only; prefer `styleNonce`.

SSG and ISG output cannot reuse a request nonce. For static documents, keep CSS linked rather than inlined, or allow the exact inline content by hash. The `viewTransitions` style never changes, so allow it with `'sha256-SREix9zPMZHrSuo8zRSjb672r1gsHIh96MJuaZq6iJo='`.

### Framework-generated scripts

Buffered pages need no inline scripts. Two features emit them:

- Streaming routes (`streaming: true`) emit scripts for deferred data and Suspense boundary swaps.
- Routes with `speculation` emit a speculation rules script.

Return the nonce as `scriptNonce` from the shell's `head()` and allow it in `script-src`:

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

[Server islands](/docs/server-islands) need nothing extra: the script that fills them is a same-origin module covered by `script-src 'self'` and `connect-src 'self'`.

## 4. Verify

1. Load an SSR page and an SSG or ISG page in a browser.
2. Navigate client-side between routes.
3. Check the console. A blocked resource logs a `Content-Security-Policy` violation naming the directive; widen only that directive.

## Inline script entries in `head()`

pracht renders pages without app-authored inline scripts. If a route's `head()` returns inline `script` entries, such as JSON-LD, test that route with the CSP enabled and allow the exact content with a hash.

## Headers on SSG and ISG pages

Headers on SSG and ISG pages are stored with the output and replayed to every visitor, so keep them public and replay-safe. Prerendering fails if they include `Set-Cookie`, authentication headers such as `Authorization`, or secret-shaped custom `x-*` headers; set those from API routes, middleware responses, or SSR routes.
