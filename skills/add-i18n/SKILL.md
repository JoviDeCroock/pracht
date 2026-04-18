---
name: add-i18n
version: 1.0.0
description: |
  Wire internationalization into a pracht app following the framework's
  recommended pattern (middleware detects locale, loaders return translations,
  components consume via route data). Generates locale dictionaries, the
  detection middleware (URL-prefix, cookie, or `Accept-Language`), and a
  helper for in-component translation.
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

Pracht ships no i18n library — the framework gives you primitives. The
recommended recipe lives at
`examples/docs/src/routes/docs/recipes-i18n.md`.

## Step 1: Pick the locale-detection strategy

Use `AskUserQuestion`:

| Strategy        | URL shape          | Pros                          | Cons                       |
| --------------- | ------------------ | ----------------------------- | -------------------------- |
| URL-prefix      | `/fr/about`        | Best for SEO; explicit        | Requires manifest changes  |
| Cookie          | `/about` + cookie  | URL stays clean               | Hidden state; SEO weaker   |
| Accept-Language | `/about` (varies)  | No user action                | Caching/SEO get tricky     |

Default to **URL-prefix** unless the user explicitly chooses otherwise.

## Step 2: Pick the supported locales

Ask once. Default suggestion: `en` plus one to two more. Confirm a default
locale (used as fallback in `t()`).

## Step 3: Translation files

`src/i18n/<locale>.ts` per locale:

```ts
export default {
  "home.title": "Welcome",
  "home.subtitle": "Built with pracht",
  "nav.home": "Home",
  "nav.about": "About",
} as const;
```

`src/i18n/index.ts`:

```ts
import en from "./en";
import fr from "./fr";

export const translations = { en, fr } as const;
export const defaultLocale = "en" as const;
export const supportedLocales = Object.keys(translations) as Array<keyof typeof translations>;

export type Locale = keyof typeof translations;
export type TranslationKey = keyof typeof en;

export function t(locale: string, key: TranslationKey): string {
  const dict = (translations as Record<string, Record<string, string>>)[locale]
    ?? translations[defaultLocale];
  return dict[key] ?? translations[defaultLocale][key] ?? key;
}
```

## Step 4: Locale-detection middleware

### URL-prefix variant

```ts
// src/middleware/i18n.ts
import type { MiddlewareFn } from "@pracht/core";
import { defaultLocale, supportedLocales } from "../i18n";

export const middleware: MiddlewareFn = ({ request, url }) => {
  const segments = url.pathname.split("/").filter(Boolean);
  const maybe = segments[0] ?? "";
  const locale = (supportedLocales as readonly string[]).includes(maybe) ? maybe : defaultLocale;
  request.headers.set("x-locale", locale);
};
```

### Cookie variant

```ts
import type { MiddlewareFn } from "@pracht/core";
import { defaultLocale, supportedLocales } from "../i18n";

export const middleware: MiddlewareFn = ({ request }) => {
  const cookie = request.headers.get("cookie") ?? "";
  const m = cookie.match(/locale=([^;]+)/);
  const requested = m?.[1] ?? defaultLocale;
  const locale = (supportedLocales as readonly string[]).includes(requested) ? requested : defaultLocale;
  request.headers.set("x-locale", locale);
};
```

### Accept-Language variant

```ts
import type { MiddlewareFn } from "@pracht/core";
import { defaultLocale, supportedLocales } from "../i18n";

export const middleware: MiddlewareFn = ({ request }) => {
  const header = request.headers.get("accept-language") ?? "";
  const preferred = header.split(",").map(p => p.split(";")[0]?.trim().toLowerCase().slice(0, 2));
  const match = preferred.find(p => (supportedLocales as readonly string[]).includes(p));
  request.headers.set("x-locale", match ?? defaultLocale);
};
```

## Step 5: Use in a loader

```ts
import type { LoaderArgs } from "@pracht/core";
import { t } from "../i18n";

export async function loader({ request }: LoaderArgs) {
  const locale = request.headers.get("x-locale") ?? "en";
  return {
    locale,
    title: t(locale, "home.title"),
    subtitle: t(locale, "home.subtitle"),
  };
}
```

## Step 6: Wire the manifest

For the URL-prefix strategy, the routes need to live under per-locale
groups. Update `src/routes.ts`:

```ts
import { defineApp, group, route } from "@pracht/core";

export const app = defineApp({
  middleware: { i18n: "./middleware/i18n.ts" },
  routes: [
    group({ middleware: ["i18n"] }, [
      route("/", "./routes/home.tsx", { id: "home-default" }),
      route("/:locale/", "./routes/home.tsx", { id: "home-localized" }),
      route("/:locale/about", "./routes/about.tsx"),
    ]),
  ],
});
```

For cookie / Accept-Language strategies, just add the middleware to the root
group; no path changes.

## Step 7: SEO touch-ups

- Set `lang` in `head()` per route from the resolved locale.
- For URL-prefix: emit `<link rel="alternate" hreflang="fr" href="...">`
  pairs in `head()` so search engines learn the locale graph.
- Update sitemap (cross-reference with `audit-seo`) to include all
  per-locale URLs.

## Step 8: String extraction (optional)

Add a script that:

1. Greps for `t(locale, "...")` calls.
2. Builds a key set.
3. Diffs against each `src/i18n/<locale>.ts`.
4. Reports missing keys per locale.

```bash
node scripts/i18n-extract.mjs
```

The output is a TODO list per locale, not auto-translation.

## Step 9: Verify

- Boot dev: `pracht dev`.
- Visit `/` and the locale-prefixed variant; confirm content swaps.
- `pnpm test` and `pnpm e2e` still pass.

## Rules

1. The middleware sets a request header; loaders read it. Do not stash the
   locale in module-level state — concurrent requests will collide.
2. Always include the default locale as the fallback in `t()`.
3. For SSG, only prerender the URL combinations that exist; provide
   `getStaticPaths` returning the locale × dynamic-param product.
4. Recommend `Intl.DateTimeFormat` and `Intl.NumberFormat` for formatting —
   no library needed.
5. Never bundle every translation into the client. If translations grow
   large, split per-locale and import lazily in loaders.

$ARGUMENTS
