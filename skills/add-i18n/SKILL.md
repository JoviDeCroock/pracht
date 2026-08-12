---
name: add-i18n
version: 2.0.1
description: |
  Wire internationalization into a pracht app with the first-party
  `@pracht/i18n` package, following the framework's recommended pattern
  (middleware detects locale, loaders return translations, components
  consume via route data). Sets up the i18n instance, lazy locale
  dictionaries with typed keys, the detection middleware (URL-prefix,
  cookie, and `Accept-Language`), locale-prefixed route groups, and
  hreflang metadata.
  Use when asked to "add i18n", "set up translations", "make my app
  multilingual", "add locale routing", or "extract strings".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Pracht Add i18n

Pracht ships its i18n primitives as `@pracht/i18n`: locale-detection
middleware, lazy dictionaries with keys typed from the default locale,
`t()`/`tPlural()` (plurals via `Intl.PluralRules`), `localePath()`, and an
`hreflang()` helper for `head()`. The full guide lives at
`examples/docs/src/routes/docs/recipes-i18n.md`; a working setup is in
`examples/basic` (`/welcome`, `/en/welcome`, `/nl/welcome`). That page also
keeps a hand-rolled fallback recipe if the user refuses the dependency.

If the pracht MCP server is registered (see docs/MCP.md), prefer its tools
(`inspect_routes`, `inspect_api`, `inspect_build`, `doctor`, `verify`,
`generate_*`) over shelling out. Prerequisite: `pracht inspect` needs a vite
config with the pracht plugin registered.

## Step 1: Pick locales and detection order

Use `AskUserQuestion` once for: supported locales (default: `en` plus one or
two more), the default locale, and the detection order. The package default —
`["path", "cookie", "header"]` (explicit URL prefix beats the remembered
cookie beats `Accept-Language`) — is right for almost everyone; only change
it when the user explicitly wants cookie-only or header-only detection.

Install the package:

```bash
npm install @pracht/i18n
```

## Step 2: The i18n instance and dictionaries

```ts
// src/i18n/index.ts
import { createDictionaries, defineI18n } from "@pracht/i18n";

export const i18n = defineI18n({
  locales: ["en", "fr"],
  defaultLocale: "en",
});

export type AppLocale = (typeof i18n.locales)[number];

export const dictionaries = createDictionaries(
  {
    en: () => import("./locales/en.ts"),
    fr: () => import("./locales/fr.ts"),
  },
  { defaultLocale: "en" },
);
```

One dictionary module per locale — flat string keys, default export,
`as const` so key typing works:

```ts
// src/i18n/locales/en.ts
export default {
  "home.title": "Welcome, {name}",
  "cart.items.one": "{count} item",
  "cart.items.other": "{count} items",
} as const;
```

Plural keys declare one entry per `Intl.PluralRules` category the locale
needs (`.one`, `.other`, plus `.few`/`.many` for e.g. Polish); `tPlural()`
falls back to `.other`. Non-default locales may omit keys — `load()` merges
the default locale underneath.

## Step 3: Detection middleware

```ts
// src/middleware/i18n.ts
import { i18n } from "../i18n/index.ts";

export const middleware = i18n.middleware;
```

The middleware sets `context.locale` and persists URL-prefix choices in a
`SameSite=Lax` cookie — but only on per-request (SSR/SPA) routes: SSG/ISG
output is stored and replayed to every visitor, so the middleware never
attaches `Set-Cookie` there (a baked-in cookie would fail the prerender
build and block ISG revalidation). It also appends `Vary: Cookie` /
`Accept-Language` when those sources were consulted, so shared caches key
correctly. Type the context once via the Register pattern:

```ts
// src/env.d.ts
import type { I18nRequestContext } from "@pracht/i18n";

declare module "@pracht/core" {
  interface Register {
    context: I18nRequestContext<"en" | "fr">;
  }
}
```

Intersect with the existing registered context type if the app already has
one.

## Step 4: Wire the manifest

One `pathPrefix` group per locale — only registered locales produce URLs, so
`/zz/about` 404s instead of serving duplicate default-locale content (never
use a `/:locale` param route for this; it matches any first segment):

```ts
import { defineApp, group, route } from "@pracht/core";

const localizedRoutes = [
  route("/", "./routes/home.tsx", { render: "ssr" }),
  route("/about", "./routes/about.tsx", { render: "ssr" }),
];

export const app = defineApp({
  middleware: { i18n: "./middleware/i18n.ts" },
  routes: [
    group({ middleware: ["i18n"] }, [
      group({ pathPrefix: "/en" }, localizedRoutes),
      group({ pathPrefix: "/fr" }, localizedRoutes),
      route("/", "./routes/locale-redirect.tsx", { render: "ssr" }),
    ]),
  ],
});
```

Notes:

- Reusing one `localizedRoutes` array is fine with auto-generated ids; if
  the app sets explicit `id`s, each locale's copy needs unique ids.
- The unprefixed detector redirects using what the middleware resolved.
  `return` the redirect — a *thrown* Response short-circuits past the
  middleware chain, so the i18n middleware could not stamp
  `Vary: Cookie, Accept-Language` on it (a shared cache could then replay
  one visitor's locale redirect to everyone):

```ts
// src/routes/locale-redirect.tsx
import { redirect, type LoaderArgs } from "@pracht/core";
import { i18n } from "../i18n/index.ts";

export async function loader({ context, request }: LoaderArgs) {
  return redirect(i18n.localePath("/", context.locale), { request });
}

export function Component() {
  return null;
}
```

- Route matching is exact: locale prefixes are lowercase URLs; build links
  with `i18n.localePath()` so they always come out canonical.
- Cookie/header-only strategies (no URL prefixes): add the middleware to the
  root group and skip the prefix groups and detector route.

## Step 5: Use in loaders and components

```tsx
import type { HeadArgs, LoaderArgs, RouteComponentProps } from "@pracht/core";
import { t, tPlural } from "@pracht/i18n";
import { dictionaries, i18n } from "../i18n/index.ts";

export async function loader({ context }: LoaderArgs) {
  const messages = await dictionaries.load(context.locale);
  return { locale: context.locale, messages };
}

export function head({ data, url }: HeadArgs<typeof loader>) {
  return {
    lang: data.locale,
    title: t(data.messages, "home.title"),
    link: i18n.hreflang(url.pathname, { origin: "https://example.com" }),
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return <h1>{t(data.messages, "home.title", { name: "Jovi" })}</h1>;
}
```

`messages` is a plain serializable object, so the same `t()` calls work
after hydration and on client navigations. `hreflang()` emits one alternate
link per locale plus `x-default` pointing at the unprefixed detector; pass
the app's canonical origin.

## Step 6: SEO touch-ups

- Set `lang` from the resolved locale in `head()` (as above).
- Keep the detector route SSR; locale-prefixed routes may be `ssg` or
  `isg` — every prefixed URL is a real route, so each locale prerenders,
  and the middleware skips cookie persistence on those routes so no
  `Set-Cookie` lands in stored output. Keep `"path"` first in the detect
  order for prerendered routes: cookie/header detection cannot run against
  a stored document (prerender/ISG requests carry no cookies or
  `Accept-Language`), and a route that *depends* on those sources gets
  `Vary: Cookie` and is refused by the ISG cache.
- Prerendered `head()` runs against a placeholder request origin — pass the
  app's canonical origin to `hreflang()` on SSG/ISG routes instead of
  `url.origin`, or the alternates bake in `http://localhost`.
- Update the sitemap (cross-reference with `audit-seo`) to include all
  per-locale URLs.

## Step 7: Verify

- Step 4 changed route paths — run `pracht typegen` to refresh the generated
  route types/`href()` helper. Add `pracht typegen --check` to CI so stale
  types fail the build.
- Boot dev: `pracht dev`.
- `curl -i` the unprefixed detector with `Accept-Language: fr` (expect a 302
  to `/fr/...`), with a `pracht_locale` cookie (cookie beats header), and
  with garbage (`;q=`, unknown tags — expect the default locale).
- Visit a locale-prefixed page; confirm translated content, the
  `Set-Cookie` on first visit, and the hreflang links in the document head.
- Visit an unsupported prefix (e.g. `/zz/about`); confirm it 404s.
- `pnpm test` and `pnpm e2e` still pass.
- Run `pracht verify --json` and confirm no failures.

## Rules

1. The middleware sets `context.locale`; loaders read it. Do not stash the
   locale in module-level state — concurrent requests will collide.
2. Only registered locales may ever reach paths, cookies, or hreflang.
   `defineI18n`/`localePath` enforce this — never bypass them with string
   concatenation on user input.
3. For SSG, only prerender URL combinations that exist; provide
   `getStaticPaths` returning the locale × dynamic-param product when a
   localized route has dynamic segments.
4. Recommend `Intl.DateTimeFormat` and `Intl.NumberFormat` with
   `data.locale` for formatting — no library needed.
5. Never bundle every translation into the client: `createDictionaries`
   loaders are per-locale lazy imports resolved in loaders; keep them that
   way.

$ARGUMENTS
