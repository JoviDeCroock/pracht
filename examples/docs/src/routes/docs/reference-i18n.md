---
title: i18n Reference
lead: The full API of `@pracht/i18n` — locale detection, typed lazy dictionaries, translation helpers, locale-prefixed paths, and hreflang. For a walkthrough, start with the i18n recipe.
breadcrumb: i18n
prev:
  href: /docs/reference/config
  title: Configuration
---

`@pracht/i18n` is an optional package. The [i18n recipe](/docs/recipes/i18n)
walks through both strategies: locale-prefixed routes, and one URL per page with
a cookie.

```sh
npm install @pracht/i18n
```

---

## `defineI18n(config)`

Creates the i18n instance: detection middleware plus the path and hreflang
helpers, all bound to one locale list.

```ts [src/i18n.ts]
import { defineI18n } from "@pracht/i18n";

export const i18n = defineI18n({
  locales: ["en", "nl", "fr"],
  defaultLocale: "en",
});
```

| Config field | Default | Description |
| --- | --- | --- |
| `locales` | — | **Required.** Every locale the app serves. Only these can ever win detection |
| `defaultLocale` | — | **Required.** Fallback when nothing matches. Must be in `locales` |
| `detect` | `["path", "cookie", "header"]` | Detection order: an explicit URL prefix beats a remembered cookie beats `Accept-Language` |
| `cookie` | enabled | Cookie options, or `false` to disable both persistence and the `"cookie"` detection source |

### The returned instance

| Member | Description |
| --- | --- |
| `middleware` | Locale-detection middleware. Resolves the locale, sets `context.locale`, and persists it in the cookie when a URL prefix chose it. Register it in `defineApp({ middleware })` |
| `locales`, `defaultLocale` | The configured values, readonly |
| `cookieName` | The cookie name in use, or `null` when the cookie is disabled |
| `isLocale(value)` | Type guard — `true` only for registered locales |
| `detect(request, url?)` | Run detection outside the middleware. Returns `{ locale, source }`, where `source` is `"path"`, `"cookie"`, `"header"`, or `"default"` |
| `detectClient()` | The browser counterpart, reading `location.pathname`, `document.cookie`, and `navigator.languages`. Yields the default locale during SSR |
| `localeCookie(locale, options?)` | Serialize a `Set-Cookie` value remembering `locale` — or an expired one for `null`, returning to automatic detection. Throws when the cookie is disabled or the locale is unregistered |
| `setLocaleCookie(locale, options?)` | Browser-only: write that cookie through `document.cookie` so a client-side switch survives the next server render |
| `localePath(path, locale)` | Prefix a path with a locale, replacing any existing prefix and preserving query and hash. Throws on unregistered locales |
| `splitLocale(path)` | Split a pathname into `{ locale, pathname }` |
| `hreflang(path, options?)` | Build `link[]` alternate entries for a `head()` export |

Merge `I18nRequestContext` into the framework's `Register` interface so loaders
see a typed `context.locale` without casts — the [recipe](/docs/recipes/i18n)
shows the declaration.

`localeCookie()` and `setLocaleCookie()` take `{ url, secure }`. `Secure` is
inferred from `url`, as the middleware does; `secure` forces it.

### `hreflang(path, options?)`

| Option | Default | Description |
| --- | --- | --- |
| `origin` | *(none)* | Absolute origin prepended to every href. Google expects absolute hreflang URLs; omit it only for same-origin previews |
| `xDefault` | the unprefixed path | The `x-default` target. Pass a registered locale to point at that locale's URL, or `false` to omit the entry |

---

## Dictionaries

`createDictionaries()` registers one lazy loader per locale. The default
locale's dictionary defines the key set and fills any key a translation is
missing, so every key always resolves.

```ts [src/dictionaries.ts]
import { createDictionaries } from "@pracht/i18n";

export const dictionaries = createDictionaries(
  {
    en: () => import("./locales/en.json"),
    nl: () => import("./locales/nl.json"),
  },
  { defaultLocale: "en" },
);
```

| Member | Description |
| --- | --- |
| `load(locale)` | Load and cache one locale's dictionary, merged over the default locale's. Unknown locales get the default |
| `locales`, `defaultLocale` | The configured values, readonly |

Keys are typed from the default locale's shape, so a typo in `t()` is a compile
error. `$`-prefixed keys are reserved. A failed import is retried on the next
`load()`.

Load the dictionary in a loader and return the messages as route data:

```ts [src/routes/home.tsx]
export async function loader({ context }: LoaderArgs) {
  return { messages: await dictionaries.load(context.locale) };
}
```

---

## Translating

| Export | Description |
| --- | --- |
| `t(messages, key, params?)` | Translate a key with optional `{param}` interpolation. A key missing everywhere returns the key itself |
| `tPlural(messages, key, count, params?)` | Translate a plural key. Declare one entry per `Intl.PluralRules` category the locale needs — `<key>.one`, `<key>.other`, and e.g. `<key>.few` / `<key>.many` for Polish. A missing category falls back to `<key>.other`; `{count}` is always available |
| `interpolate(template, params?)` | Replace `{name}` placeholders in a single pass; values are not re-scanned. Unknown placeholders are left as-is |

```tsx
import { t, tPlural } from "@pracht/i18n";

const { messages } = useRouteData<typeof loader>();

t(messages, "greeting", { name: "Ada" });   // "Hello, Ada"
tPlural(messages, "items", cart.length);    // "3 items"
```

---

## `Accept-Language`

The detection middleware uses these. Call them to negotiate a locale yourself,
e.g. in an API route.

| Export | Description |
| --- | --- |
| `parseAcceptLanguage(header)` | Parse the header into entries, highest q-value first. Malformed and `q=0` entries are dropped |
| `matchAcceptLanguage(header, locales, options?)` | Pick the best registered locale, or `null` when nothing matches |

Matching runs per entry in q-value order:

1. Exact tag match, case-insensitive — `nl` → `nl`
2. RFC 4647 lookup, truncating the tag from the right — `zh-Hant-TW` → `zh-Hant` → `zh`, so `nl-BE` → `nl`
3. A registered locale sharing the tag's primary language — `en-GB` → `en-US`
