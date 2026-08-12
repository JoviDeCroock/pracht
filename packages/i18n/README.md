# @pracht/i18n

First-party i18n primitives for [Pracht](https://github.com/JoviDeCroock/pracht),
productizing the framework's documented pattern: **middleware detects the
locale → loaders return translations → components consume them via route
data**. This is deliberately not a translation framework — it is the typed
plumbing around locale detection, lazy dictionaries, plural selection, and
hreflang metadata.

```bash
npm install @pracht/i18n
```

## Quick start

```ts
// src/i18n/index.ts — one instance per app
import { createDictionaries, defineI18n } from "@pracht/i18n";

export const i18n = defineI18n({
  locales: ["en", "nl"],
  defaultLocale: "en",
});

export const dictionaries = createDictionaries(
  {
    en: () => import("./locales/en.ts"),
    nl: () => import("./locales/nl.ts"),
  },
  { defaultLocale: "en" },
);
```

```ts
// src/middleware/i18n.ts — the manifest expects a `middleware` export
import { i18n } from "../i18n/index.ts";

export const middleware = i18n.middleware;
```

```ts
// src/routes.ts — one pathPrefix group per locale; only registered locales
// ever match, so /zz/shop 404s instead of serving duplicate content
group({ middleware: ["i18n"] }, [
  route("/welcome", () => import("./routes/welcome-redirect.tsx"), { render: "ssr" }),
  group({ pathPrefix: "/en" }, [route("/welcome", () => import("./routes/welcome.tsx"), { render: "ssr" })]),
  group({ pathPrefix: "/nl" }, [route("/welcome", () => import("./routes/welcome.tsx"), { render: "ssr" })]),
]),
```

```tsx
// src/routes/welcome.tsx
export async function loader({ context }: LoaderArgs<I18nRequestContext<"en" | "nl">>) {
  const messages = await dictionaries.load(context.locale);
  return { locale: context.locale, messages };
}

export function head({ data, url }: HeadArgs<typeof loader>) {
  return {
    lang: data.locale,
    title: t(data.messages, "welcome.title"),
    link: i18n.hreflang(url.pathname, { origin: "https://example.com" }),
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return <h1>{t(data.messages, "welcome.title", { name: "Jovi" })}</h1>;
}
```

A complete, tested setup lives in
[`examples/basic`](../../examples/basic) (`/welcome`, `/en/welcome`,
`/nl/welcome`), and the full guide is the
[i18n recipe](https://pracht.resynapse.dev/docs/recipes/i18n).

## `defineI18n({ locales, defaultLocale, detect?, cookie? })`

Creates the app's i18n instance:

- **`middleware`** — resolves the locale (default order: URL prefix →
  cookie → `Accept-Language` q-values), sets `context.locale`, and persists
  an explicit URL-prefix choice in the locale cookie (`Path=/`,
  `SameSite=Lax`, one year, `Secure` on https). Persistence is skipped on
  prerenderable (SSG/ISG) routes — their output is stored and replayed to
  every visitor, so it must never carry `Set-Cookie` — and header-derived
  locales are never persisted. The middleware also appends
  `Vary: Cookie` / `Accept-Language` when those sources were consulted, so
  shared caches key correctly. Note: a **thrown** `Response`
  (`throw redirect(...)`) short-circuits past the middleware chain and gets
  neither the cookie nor `Vary` — `return` redirects from loaders on
  localized routes instead.
- **`localePath(path, locale)`** — prefix/replace the locale in a path,
  preserving query and hash. Throws for unregistered locales, so user input
  can never be reflected into a URL.
- **`splitLocale(path)`** / **`isLocale(value)`** / **`detect(request)`** —
  the underlying primitives.
- **`hreflang(path, { origin?, xDefault? })`** — `link[]` alternate entries
  for `head()`: one per locale plus `x-default` (the unprefixed detector
  route by default).

Only registered locales can ever win detection: URL prefixes, cookie values,
and `Accept-Language` tags are validated against the registry, malformed
q-values (`;q=`, `;q=abc`) are dropped rather than promoted, and oversized
headers are truncated. Header matching follows RFC 4647 lookup —
progressive truncation (`zh-Hant-TW` → `zh-Hant` → `zh`) — plus a
same-language best fit (`en-GB` matches a registered `en-US`) before
falling through to lower-preference entries.

Note that route matching is exact: `pathPrefix: "/nl"` serves `/nl/...`,
not `/NL/...`. Keep locale prefixes lowercase in links (use `localePath`).

## Dictionaries

Flat string keys, one module per locale, default export:

```ts
// src/i18n/locales/en.ts
export default {
  "home.title": "Welcome, {name}",
  "notes.count.one": "{count} note",
  "notes.count.other": "{count} notes",
} as const;
```

- `dictionaries.load(locale)` lazily imports the locale (cached), merged
  over the default locale so every key resolves. The result is a plain
  serializable object (plus a reserved `$locale` key) — return it from a
  loader and use the same `t()` on the client.
- `t(messages, key, params?)` — typed keys derived from the default
  locale's shape; `{param}` interpolation is single-pass (values containing
  braces are never re-interpolated) and reads own properties only. Unknown
  dynamic keys return the key itself.
- `tPlural(messages, key, count, params?)` — selects `<key>.<category>` via
  `Intl.PluralRules` for the dictionary's locale (declare `.few`/`.many`
  for locales like Polish), falling back to `<key>.other`. `{count}` is
  always available as a param.

## Typing `context.locale`

The middleware writes `context.locale`. Register it once via the framework's
`Register` pattern:

```ts
// src/env.d.ts
import type { I18nRequestContext } from "@pracht/i18n";

declare module "@pracht/core" {
  interface Register {
    context: I18nRequestContext<"en" | "nl">;
  }
}
```

(Intersect with your adapter context if you already register one.)
