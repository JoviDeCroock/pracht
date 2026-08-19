---
name: add-i18n
version: 2.1.0
description: |
  Wire internationalization into a pracht app with the first-party
  `@pracht/i18n` package, following the framework's recommended pattern
  (middleware detects locale, loaders return translations, components
  consume via route data). Sets up the i18n instance, lazy locale
  dictionaries with typed keys, the detection middleware (URL-prefix,
  cookie, and `Accept-Language`), and either strategy: locale-prefixed
  route groups with hreflang metadata, or one URL per page with a
  cookie-backed switcher that changes no URLs.
  Use when asked to "add i18n", "set up translations", "make my app
  multilingual", "add locale routing", "switch language without changing
  URLs", or "extract strings".
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
`examples/docs/src/routes/docs/recipes-i18n.md`; working setups are in
`examples/basic` — locale-prefixed (`/welcome`, `/en/welcome`,
`/nl/welcome`) and prefix-free (`/greeting`, `src/api/locale.ts`). That page
also keeps a hand-rolled fallback recipe if the user refuses the dependency.

If the pracht MCP server is registered (see docs/MCP.md), prefer its tools
(`inspect_routes`, `inspect_api`, `inspect_build`, `doctor`, `verify`,
`generate_*`) over shelling out. Prerequisite: `pracht inspect` needs a vite
config with the pracht plugin registered.

## Step 1: Pick locales and a URL strategy

Use `AskUserQuestion` once for: supported locales (default: `en` plus one or
two more), the default locale, and the **URL strategy**:

- **A. Locale-prefixed URLs** (`/en/about`) — the default for public,
  indexable content: each language is its own URL, `hreflang()` works, and
  routes can stay `ssg`/`isg`. Adopting it changes every URL.
- **B. One URL per page** (`/about`) — for an existing site whose URLs
  cannot move, or an app behind a login where indexing does not matter. The
  cookie decides the locale, switching needs no navigation, and no URL
  changes. Cost: `Vary: Cookie, Accept-Language` makes those routes
  per-request (`ssr`/`spa`, never `ssg`/`isg`) and a single URL cannot carry
  hreflang alternates.

Ask explicitly if the user already has a live site — never migrate an
existing app's URLs without saying so. Both strategies can coexist in one
app on one instance.

Keep the default detection order `["path", "cookie", "header"]` in both
cases (the path source simply never matches a prefix-free route); only
change it when the user explicitly wants cookie-only or header-only
detection.

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
`Accept-Language` when those sources were consulted. Path-resolved SSR/SPA
responses vary on `Cookie` too, because the presence of their persistence
`Set-Cookie` depends on the incoming cookie; path-only SSG/ISG output stays
keyed solely by URL. Type the context once via the Register pattern:

Cookie configuration stays browser-valid: `SameSite=None` always forces
`Secure`, even if an explicit option attempts to disable it.

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

### Strategy A — locale-prefixed URLs

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
  with `i18n.localePath()` so they always come out canonical. It resolves
  literal and encoded dot segments before prefixing, so even a path assembled
  from user input cannot escape the locale namespace during browser URL
  normalization.
- If localized routes are SSG/ISG, their stored response cannot safely carry
  a visitor-specific `Set-Cookie`. In a hydrated component shared by those
  routes, persist the explicit prefix with
  `useEffect(() => { i18n.setLocaleCookie(data.locale); }, [data.locale])` so the
  SSR detector remembers it later. This is harmless on SSR pages. Without
  JavaScript, remembering a prerendered visit requires SSR or platform edge
  middleware before static asset serving.

### Strategy B — one URL per page

Nothing about the routes changes: add the middleware to the group and skip
the prefix groups and the detector route entirely. Detection falls to the
cookie, then `Accept-Language`; the middleware adds
`Vary: Cookie, Accept-Language`, so keep those routes `ssr`/`spa`.

Because no URL prefix ever signals an explicit choice, the *switcher* writes
the cookie. Generate an API route (works with JavaScript disabled):

```ts
// src/api/locale.ts
import { redirect, type BaseRouteArgs } from "@pracht/core";
import { i18n } from "../i18n/index.ts";

function sameOriginPath(value: FormDataEntryValue | null, base: URL, fallback: string): string {
  if (typeof value !== "string" || !value.startsWith("/")) return fallback;
  try {
    const target = new URL(value, base);
    return target.origin === base.origin
      ? `${target.pathname}${target.search}${target.hash}`
      : fallback;
  } catch {
    return fallback;
  }
}

export async function POST({ request, url }: BaseRouteArgs) {
  const form = await request.formData();
  const locale = form.get("locale");
  if (!i18n.isLocale(locale)) return new Response("Unknown locale", { status: 400 });

  // Parse `next` before trusting it: URL normalization can expose an origin.
  const next = form.get("next");
  const target = sameOriginPath(next, url, "/");

  const response = redirect(target, { request, status: 303 });
  response.headers.append("set-cookie", i18n.localeCookie(locale, { url }));
  return response;
}
```

…and a `<Form method="post" action="/api/locale">` switcher with one
`<button name="locale" value={locale}>` per locale plus a hidden `next`
field carrying `useLocation().pathname + useLocation().search` so switching
does not drop the current query. Hydrated, `<Form>` uses the framework's
redirect handshake and re-runs the loader; without JavaScript the browser
follows the 303 normally.

For an instant switch with no request at all, `i18n.setLocaleCookie(locale)`
writes the same cookie from the browser and
`await dictionaries.load(locale)` swaps the dictionary in place — hold the
result in state, reset it when loader data changes, and set both
`document.documentElement.lang` and a localized `document.title` by hand
(`head()` already ran server-side).
Load the dictionary before writing the cookie, and guard concurrent lazy
loads with a monotonically increasing request id so only the latest successful
selection commits both the cookie and component state. Catch import failures
instead of leaving an unhandled event-handler rejection or a partially applied
locale choice. Invalidate that request id from a `useLayoutEffect` cleanup
keyed by loader messages so a loader-data change or unmount wins during commit;
a passive `useEffect` cleanup leaves time for a stale import to write its cookie.
Also increment the shared request id synchronously in the server switcher's
`<Form onSubmit>` and before any other navigation that can replace loader data.
Cleanup at commit cannot undo a stale cookie written while that transition was
still in flight.
`i18n.detectClient()` is the browser-side `detect()` if a client-only
surface needs to resolve the locale itself.

## Step 5: Use in loaders and components

```tsx
import type { HeadArgs, LoaderArgs, RouteComponentProps } from "@pracht/core";
import { t, tPlural } from "@pracht/i18n";
import { dictionaries, i18n } from "../i18n/index.ts";
import { useEffect } from "preact/hooks";

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
  // Required for SSG/ISG locale routes; harmless when SSR middleware already
  // persisted the matching path locale.
  useEffect(() => {
    i18n.setLocaleCookie(data.locale);
  }, [data.locale]);
  return <h1>{t(data.messages, "home.title", { name: "Jovi" })}</h1>;
}
```

`messages` is a plain serializable object, so the same `t()` calls work
after hydration and on client navigations. `hreflang()` emits one alternate
link per locale plus `x-default` pointing at the unprefixed detector; pass
the app's canonical origin. Relative previews remain current-origin because
`splitLocale()` always keeps the stripped pathname root-relative, and every
alternate preserves an input query/hash suffix. Under strategy B, omit the
`link` entry: there is no alternate URL to point at, so emitting hreflang
would be a lie.

## Step 6: SEO touch-ups

- Set `lang` from the resolved locale in `head()` (as above).
- Keep the detector route SSR; locale-prefixed routes may be `ssg` or
  `isg` — every prefixed URL is a real route, so each locale prerenders,
  and the middleware skips cookie persistence on those routes so no
  `Set-Cookie` lands in stored output. Persist the resolved path locale after
  hydration when the SSR detector should remember it; without JavaScript,
  use SSR or platform edge middleware. Keep `"path"` first in the detect order
  for prerendered routes: cookie/header detection cannot run against a stored
  document (prerender/ISG requests carry no cookies or `Accept-Language`), and
  a route that *depends* on those sources gets `Vary: Cookie` and is refused by
  the ISG cache.
- Prerendered `head()` runs against a placeholder request origin — pass the
  app's canonical origin to `hreflang()` on SSG/ISG routes instead of
  `url.origin`, or the alternates bake in `http://localhost`.
- Update the sitemap (cross-reference with `audit-seo`) to include all
  per-locale URLs.
- Strategy B only: one URL means one indexed language (whatever the
  crawler's `Accept-Language` resolves to). Say this out loud to the user;
  if it matters, that is the argument for strategy A. Still set `lang`, and
  leave sitemap entries as the single canonical URLs they already are.

## Step 7: Verify

- If step 4 changed route paths (strategy A) or added the API route, run
  `pracht typegen` to refresh the generated route types/`href()` helper. Add
  `pracht typegen --check` to CI so stale types fail the build.
- Boot dev: `pracht dev`.
- Strategy A: `curl -i` the unprefixed detector with `Accept-Language: fr`
  (expect a 302 to `/fr/...`), with a `pracht_locale` cookie (cookie beats
  header), and with garbage (`;q=`, unknown tags — expect the default
  locale). Visit a locale-prefixed page; confirm translated content and the
  hreflang links in the head. On SSR, confirm `Set-Cookie` on first visit and
  `Vary: Cookie` whether or not the request cookie already matches. On SSG/ISG,
  confirm the stored response has neither `Set-Cookie` nor a path-only `Vary`, hydration writes
  the locale cookie, and then the unprefixed detector returns to that locale.
  Visit an unsupported prefix (e.g. `/zz/about`); confirm it 404s.
- Strategy B: `curl -i` the page with `Accept-Language: fr` (expect French
  content, `Vary: Cookie, Accept-Language`, no `Set-Cookie`) and with
  `Cookie: pracht_locale=fr` while sending `Accept-Language: en` (cookie
  wins). `curl -i -X POST` the switcher with `-d locale=fr` and an
  `Origin` header matching the host (mutation API routes are
  same-origin-checked): expect a 303 plus `Set-Cookie`. Post an unregistered
  locale and an off-origin `next`; expect a 400 and a same-origin redirect.
  In the browser, switch and confirm the URL never changes.
- `pnpm test` and `pnpm e2e` still pass.
- Run `pracht verify --json` and confirm no failures.

## Rules

1. The middleware sets `context.locale`; loaders read it. Do not stash the
   locale in module-level state — concurrent requests will collide.
2. Only registered locales may ever reach paths, cookies, or hreflang.
   `defineI18n`/`localePath` enforce this — never bypass them with string
   concatenation on user input. `localePath` also resolves dot segments before
   adding the locale prefix. Accept-Language wildcard fallbacks are resolved
   through the registered locale list, respect explicit `q=0` exclusions, and
   neither lookup truncation nor best-fit fallback can bypass those exclusions.
   Directly matched longer variants win before same-language best fit, which
   never crosses conflicting script subtags. If the defensive header-length
   limit cuts an entry in half, discard that entry rather than parsing it with
   an implied quality of 1.
3. For SSG, only prerender URL combinations that exist; provide
   `getStaticPaths` returning the locale × dynamic-param product when a
   localized route has dynamic segments.
4. Recommend `Intl.DateTimeFormat` and `Intl.NumberFormat` with
   `data.locale` for formatting — no library needed.
5. Never bundle every translation into the client: `createDictionaries`
   loaders are per-locale lazy imports resolved in loaders; keep them that
   way.
6. Never move an existing app's URLs without asking. Locale prefixes are a
   strategy, not a requirement — if the user says their URLs are fixed,
   strategy B is the answer, not a redirect table.

$ARGUMENTS
