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

> Locale prefixes are a choice, not a requirement — see
> [URL strategies](#url-strategies) if your URLs cannot change.

```tsx
// src/routes/welcome.tsx
import type { HeadArgs, LoaderArgs, RouteComponentProps } from "@pracht/core";
import { t, type I18nRequestContext } from "@pracht/i18n";
import { useEffect } from "preact/hooks";

import { dictionaries, i18n } from "../i18n/index.ts";

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
  // Required on SSG/ISG pages: their stored response cannot set a
  // visitor-specific cookie. It is harmless when middleware already did so.
  useEffect(() => i18n.setLocaleCookie(data.locale), [data.locale]);
  return <h1>{t(data.messages, "welcome.title", { name: "Jovi" })}</h1>;
}
```

A complete, tested setup lives in
[`examples/basic`](../../examples/basic) — locale-prefixed (`/welcome`,
`/en/welcome`, `/nl/welcome`) and prefix-free (`/greeting`) against one
instance — and the full guide is the
[i18n recipe](https://pracht.resynapse.dev/docs/recipes/i18n).

## URL strategies

Detection, dictionaries, and `t()` are identical either way; the only
question is whether the locale is part of the URL.

**A. Locale-prefixed URLs** (`/en/about`) — one `pathPrefix` group per
locale, switching means navigating, `hreflang()` gives every language its
own indexable URL, and routes can be `ssg`/`isg`. The better default for
public content. On SSG/ISG pages, persist the explicit prefix after hydration
with `setLocaleCookie()` because a stored response cannot safely carry a
visitor-specific cookie.

**B. One URL per page** (`/about`) — nothing about your routes changes. The
cookie decides, `Accept-Language` seeds the first visit, and the middleware
adds `Vary: Cookie, Accept-Language` (so these routes stay per-request:
`ssr` or `spa`, never `ssg`/`isg`). Adopting it changes no URLs, and
switching needs no navigation:

```ts
// src/api/locale.ts — switch that works without JavaScript
export async function POST({ request, url }: BaseRouteArgs) {
  const form = await request.formData();
  const locale = form.get("locale");
  if (!i18n.isLocale(locale)) return new Response("Unknown locale", { status: 400 });
  const response = redirect("/", { request, status: 303 });
  response.headers.append("set-cookie", i18n.localeCookie(locale, { url }));
  return response;
}
```

```ts
// …or entirely on the client: no request, same URL
i18n.setLocaleCookie("nl"); // remembered for the next server render
setMessages(await dictionaries.load("nl")); // lazily imported chunk
```

The trade-off is SEO: a single URL cannot carry `hreflang` alternates, so
crawlers index whichever locale their `Accept-Language` resolves to. The
detection order is the same for both (`["path", "cookie", "header"]`), so
one app can mix them — the path source simply never matches a prefix-free
route.

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
  localized routes instead. SSG/ISG requests cannot persist a visitor-specific
  cookie in stored output; call `setLocaleCookie(data.locale)` in a hydrated
  localized component so later unprefixed detector routes remember the choice.
- **`localePath(path, locale)`** — prefix/replace the locale in a path,
  preserving query and hash. It resolves literal/encoded dot segments before
  prefixing, so browser URL normalization cannot escape the locale namespace.
  Throws for unregistered locales, so user input can never be reflected into
  a URL.
- **`splitLocale(path)`** / **`isLocale(value)`** / **`detect(request)`** —
  the underlying primitives. `splitLocale()` always returns a root-relative
  pathname, including when URL normalization exposes duplicate slashes after
  the locale prefix.
- **`localeCookie(locale, { url?, secure? })`** — serialize the locale
  cookie (`null` clears it) for prefix-free switches: the middleware never
  sees an explicit choice when the URL does not carry one, so the switch
  writes it. `url` infers `Secure` exactly like the middleware;
  `SameSite=None` always forces `Secure`, including when an explicit option
  says otherwise, because browsers reject the cookie without it.
- **`setLocaleCookie(locale)`** / **`detectClient()`** — the browser
  counterparts: write the cookie through `document.cookie`, and resolve the
  locale from `location.pathname` / `document.cookie` /
  `navigator.languages` in the configured order (returns the default locale
  when called during SSR).
- **`hreflang(path, { origin?, xDefault? })`** — `link[]` alternate entries
  for `head()`: one per locale plus `x-default` (the unprefixed detector
  route by default).

Only registered locales can ever win detection: URL prefixes, cookie values,
and `Accept-Language` tags are validated against the registry, malformed or
duplicate q-values (`;q=`, `;q=abc`, repeated `;q=`) are dropped rather than
promoted, and oversized headers are truncated. A q-value must be a complete
decimal token, so a numeric prefix such as `q=0.5junk` is rejected too.
Wildcards can only resolve to a registered locale and never revive a locale
explicitly rejected with `q=0`. Header matching follows RFC 4647 lookup —
progressive truncation (`zh-Hant-TW` → `zh-Hant` → `zh`) — plus a
script-compatible same-language best fit (`en-GB` matches a registered
`en-US`, while `zh-Hans` does not best-fit `zh-Hant`) before falling through
to lower-preference entries. Every locale accepted by `defineI18n()` remains
detectable even when its full tag is longer than a common language-region pair.

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
- `$`-prefixed keys are reserved and omitted from both the loaded object and
  its translation-key type. Other own flat keys, including `__proto__`, are
  preserved without consulting or mutating an object prototype.
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
