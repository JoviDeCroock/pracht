---
title: Head and headers
lead: Set each page's title, meta tags, structured data, third-party scripts, and HTTP response headers from its loader data.
---

A route module controls its document's `<head>` with a `head` export and its HTTP response headers with a `headers` export. Both receive the [loader's](/docs/data-loading#loaders) arguments and its `data`.

## Head metadata

Export `head` from a route to set the page title, meta tags, and links. It
receives the loader's arguments plus its `data`, so each page can set a title
from its own content:

```ts [src/routes/product.tsx]
import type { HeadArgs } from "@pracht/core";

export function head({ data }: HeadArgs<typeof loader>) {
  return {
    title: `${data.product.name} — My Store`,
    meta: [
      { name: "description", content: data.product.description },
      { property: "og:title", content: data.product.name },
      { property: "og:image", content: data.product.imageUrl },
      { property: "og:type", content: "product" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    link: [{ rel: "canonical", href: `https://mystore.com/products/${data.product.slug}` }],
  };
}
```

### Head fields

| Field         | Content                                                               |
| ------------- | --------------------------------------------------------------------- |
| `title`       | Document `<title>`                                                    |
| `lang`        | `<html lang>`                                                         |
| `meta`        | `<meta>` attributes, including Open Graph and Twitter Card tags       |
| `link`        | `<link>` attributes: canonical, icons, alternates, preloads           |
| `script`      | `<script>` elements, such as JSON-LD                                  |
| `fonts`       | Fonts from [`defineFont()`](/docs/fonts)                              |
| `styleNonce`  | CSP nonce for framework-generated inline styles                       |
| `scriptNonce` | CSP nonce for framework-generated inline scripts ([CSP](/docs/recipes/csp)) |

### Structured data (JSON-LD)

Add a `script` entry with `type: "application/ld+json"`:

```ts
export function head({ data }: HeadArgs<typeof loader>) {
  return {
    title: data.article.title,
    meta: [{ property: "og:type", content: "article" }],
    script: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Article",
          headline: data.article.title,
          datePublished: data.article.publishedAt,
          author: { "@type": "Person", name: data.article.author },
        }),
      },
    ],
  };
}
```

### Shell-level defaults

Export `head` from a shell for site-wide defaults. A route's `title` and `lang`
override the shell's; `meta`, `link`, `script`, and `fonts` are concatenated,
shell entries first. A shell's `head()` does not receive route loader data.

```ts [src/shells/public.tsx]
export function head() {
  return {
    title: "My Site",
    meta: [{ property: "og:site_name", content: "My Site" }],
    link: [{ rel: "icon", href: "/favicon.svg" }],
  };
}
```

### Third-party scripts — `<Script>`

Render `<Script>` in a route or shell component for analytics, chat widgets,
and ad tags. Unlike a `head()` `script` entry, it takes a loading strategy:

```tsx
import { Script } from "@pracht/core";

export function Component() {
  return (
    <section>
      {/* Emitted into the SSR <head>, runs before hydration */}
      <Script strategy="beforeHydration" id="consent">
        {"window.consentDefaults = { analytics: false };"}
      </Script>
      {/* Default: injected once hydration completes */}
      <Script src="https://example.com/analytics.js" />
      {/* Injected in requestIdleCallback */}
      <Script strategy="idle" src="https://example.com/chat-widget.js" />
      {/* Injected when the placeholder scrolls into view */}
      <Script strategy="visible" src="https://example.com/comments.js" />
    </section>
  );
}
```

| Strategy | When the script loads |
| --- | --- |
| `"beforeHydration"` | Emitted into the document `<head>` during SSR, like `head()` scripts |
| `"afterHydration"` _(default)_ | Injected after hydration, including Suspense, completes |
| `"idle"` | Injected in `requestIdleCallback` (setTimeout fallback) |
| `"visible"` | Injected when its placeholder enters the viewport |

Props: `src` or inline string children, `id`, `async`, `defer`, `type`,
`nonce`, `integrity`, `crossorigin`, `referrerpolicy`, and client-only
`onLoad`/`onError`. A script with the same `id`, `src`, or inline content is
injected once, across re-renders, navigations, and `head()` entries.

| Route                     | Strategies that run                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `hydration: "full"`       | All; `"beforeHydration"` mounted by a client navigation is injected at once           |
| `hydration: "islands"`    | `"beforeHydration"` anywhere; client strategies only inside islands                   |
| `hydration: "none"`       | `"beforeHydration"` only; client strategies warn in dev and do nothing                |

## Document headers

Export `headers` to set HTTP headers on the route's document response. It
receives the same arguments as `head`:

```ts
export function headers({ data }: HeadersArgs<typeof loader>) {
  return {
    "content-security-policy": `default-src 'self'; img-src 'self' ${data.cdnOrigin}`,
  };
}
```

Route headers merge with the shell's `headers` export and win on a name clash.
They apply to HTML documents, including prerendered SSG and ISG pages, but not
to API routes or route-state JSON.
