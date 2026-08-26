---
name: add-i18n
version: 2.2.0
description: |
  Wire `@pracht/i18n`: locale-detection middleware (URL prefix, cookie,
  `Accept-Language`), lazy typed dictionaries, and either strategy —
  locale-prefixed route groups with hreflang, or one URL per page with a
  cookie-backed switcher.
  Use for "add i18n", "set up translations", "make my app multilingual", "add
  locale routing", "switch language without changing URLs", "extract strings".
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

`@pracht/i18n` ships locale-detection middleware, lazy dictionaries with keys
typed from the default locale, `t()`/`tPlural()` (plurals via
`Intl.PluralRules`), `localePath()`, and `hreflang()` for `head()`. Full guide:
`examples/docs/src/routes/docs/recipes-i18n.md` — which also carries a
hand-rolled fallback recipe if the user refuses the dependency. Working setups
live in `examples/basic`, both locale-prefixed (`/welcome`, `/en/welcome`,
`/nl/welcome`) and prefix-free (`/greeting`, `src/api/locale.ts`).

MCP: when the pracht MCP server is registered (docs/MCP.md), prefer its
`inspect_routes`/`inspect_api`/`inspect_build`/`doctor`/`verify`/`generate_*`
tools over shelling out. `pracht inspect` needs the pracht plugin in the vite
config.

## Step 1: Pick locales and a URL strategy

Use `AskUserQuestion` once for the supported locales (default `en` plus one or
two), the default locale, and the URL strategy:

| | **A. Locale-prefixed** (`/en/about`) | **B. One URL per page** (`/about`) |
| --- | --- | --- |
| Use when | Public, indexable content | URLs cannot move, or the app is behind a login |
| Locale from | The path | The cookie — switching needs no navigation |
| Render modes | Any, including `ssg`/`isg` | `ssr`/`spa` only (`Vary: Cookie, Accept-Language`) |
| hreflang | Works | Impossible — one URL cannot carry alternates |
| Cost | Changes every URL | One indexed language |

Never migrate a live app's URLs without saying so explicitly. Both strategies
can coexist in one app. Keep the default detection order
`["path", "cookie", "header"]` either way — the path source simply never
matches a prefix-free route — and change it only for an explicit cookie-only
or header-only request.

```bash
npm install @pracht/i18n
```

## Step 2: Instance and dictionaries

```ts
// src/i18n/index.ts
import { createDictionaries, defineI18n } from "@pracht/i18n";

export const i18n = defineI18n({ locales: ["en", "fr"], defaultLocale: "en" });

export type AppLocale = (typeof i18n.locales)[number];

export const dictionaries = createDictionaries(
  { en: () => import("./locales/en.ts"), fr: () => import("./locales/fr.ts") },
  { defaultLocale: "en" },
);
```

One dictionary module per locale — flat string keys, default export, `as const`
so key typing works:

```ts
// src/i18n/locales/en.ts
export default {
  "home.title": "Welcome, {name}",
  "cart.items.one": "{count} item",
  "cart.items.other": "{count} items",
} as const;
```

Plural keys declare one entry per `Intl.PluralRules` category the locale needs
(`.one`, `.other`, plus `.few`/`.many` for e.g. Polish); `tPlural()` falls back
to `.other`. Non-default locales may omit keys — `load()` merges the default
locale underneath.

## Step 3: Detection middleware

```ts
// src/middleware/i18n.ts
import { i18n } from "../i18n/index.ts";

export const middleware = i18n.middleware;
```

It sets `context.locale`, persists URL-prefix choices in a `SameSite=Lax`
cookie, and appends `Vary: Cookie` / `Accept-Language` for whichever sources it
consulted. Persistence happens only on per-request (SSR/SPA) routes: SSG/ISG
output is stored and replayed to every visitor, so a baked-in `Set-Cookie`
would fail the prerender build and block ISG revalidation. Path-resolved
SSR/SPA responses still vary on `Cookie`, because whether they carry that
`Set-Cookie` depends on the incoming cookie; path-only SSG/ISG output stays
keyed solely by URL. Cookie config stays browser-valid — `SameSite=None` always
forces `Secure`, even if an option tries to disable it.

Type the context once via the Register pattern, intersecting with the app's
existing registered context type if it has one:

```ts
// src/env.d.ts
import type { I18nRequestContext } from "@pracht/i18n";

declare module "@pracht/core" {
  interface Register {
    context: I18nRequestContext<"en" | "fr">;
  }
}
```

## Step 4A: Manifest — locale-prefixed URLs

One `pathPrefix` group per locale, so only registered locales produce URLs and
`/zz/about` 404s instead of serving duplicate default-locale content. Never use
a `/:locale` param route for this — it matches any first segment.

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

The unprefixed detector redirects using what the middleware resolved. **`return`
the redirect** — a *thrown* Response short-circuits past the middleware chain,
so the i18n middleware could not stamp `Vary: Cookie, Accept-Language` on it,
and a shared cache could replay one visitor's locale redirect to everyone:

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

- Reusing one `localizedRoutes` array is fine with auto-generated ids; with
  explicit `id`s, each locale's copy needs unique ones.
- Route matching is exact and locale prefixes are lowercase — build links with
  `i18n.localePath()` so they come out canonical. It resolves literal and
  encoded dot segments before prefixing, so a path assembled from user input
  cannot escape the locale namespace during browser URL normalization.
- SSG/ISG localized routes cannot carry a visitor-specific `Set-Cookie`. In a
  hydrated component shared by those routes, persist the prefix with
  `useEffect(() => { i18n.setLocaleCookie(data.locale); }, [data.locale])` so
  the SSR detector remembers it later (harmless on SSR pages). Without
  JavaScript, remembering a prerendered visit needs SSR or platform edge
  middleware ahead of static asset serving.

## Step 4B: Manifest — one URL per page

Nothing about the routes changes: add the middleware to the group, skip the
prefix groups and the detector route. Detection falls to the cookie, then
`Accept-Language`, and the `Vary: Cookie, Accept-Language` header keeps those
routes `ssr`/`spa`.

Because no URL prefix ever signals an explicit choice, the switcher writes the
cookie. Generate an API route so it works with JavaScript disabled:

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
  const target = sameOriginPath(form.get("next"), url, "/");

  const response = redirect(target, { request, status: 303 });
  response.headers.append("set-cookie", i18n.localeCookie(locale, { url }));
  return response;
}
```

Pair it with a `<Form method="post" action="/api/locale">` switcher: one
`<button name="locale" value={locale}>` per locale plus a hidden `next` field
carrying `useLocation().pathname + useLocation().search`, so switching does not
drop the current query. Hydrated, `<Form>` uses the framework's redirect
handshake and re-runs the loader; without JavaScript the browser follows the
303.

For an instant switch with no request, `i18n.setLocaleCookie(locale)` writes the
same cookie from the browser and `await dictionaries.load(locale)` swaps the
dictionary in place. That path is easy to get wrong — hold the dictionary in
state, reset it when loader data changes, and set `document.documentElement.lang`
and a localized `document.title` by hand (`head()` already ran server-side).
Then:

- Load the dictionary *before* writing the cookie.
- Guard concurrent lazy loads with a monotonically increasing request id so
  only the latest successful selection commits both cookie and state.
- Catch import failures rather than leaving an unhandled event-handler
  rejection or a half-applied locale.
- Invalidate that request id from a `useLayoutEffect` cleanup keyed by loader
  messages, so a loader-data change or unmount wins during commit; a passive
  `useEffect` cleanup leaves time for a stale import to write its cookie.
- Increment the shared request id synchronously in the server switcher's
  `<Form onSubmit>` and before any other navigation that can replace loader
  data — cleanup at commit cannot undo a stale cookie written mid-transition.

`i18n.detectClient()` is the browser-side `detect()` when a client-only surface
must resolve the locale itself.

## Step 5: Loaders and components

```tsx
import type { HeadArgs, LoaderArgs, RouteComponentProps } from "@pracht/core";
import { t } from "@pracht/i18n";
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

`messages` is a plain serializable object, so the same `t()` calls work after
hydration and on client navigations. `hreflang()` emits one alternate per
locale plus `x-default` pointing at the unprefixed detector — pass the app's
canonical origin. Relative previews stay current-origin because `splitLocale()`
keeps the stripped pathname root-relative, and every alternate preserves an
input query/hash suffix. Under strategy B, omit the `link` entry entirely:
there is no alternate URL, so emitting hreflang would be a lie.

## Step 6: SEO

- Set `lang` from the resolved locale in `head()`.
- Keep the detector route SSR. Locale-prefixed routes may be `ssg`/`isg` —
  every prefixed URL is a real route, and the middleware skips cookie
  persistence there so no `Set-Cookie` lands in stored output. Keep `"path"`
  first in the detect order for prerendered routes: cookie/header detection
  cannot run against a stored document (prerender/ISG requests carry no cookies
  or `Accept-Language`), and a route that *depends* on those sources gets
  `Vary: Cookie` and is refused by the ISG cache.
- Prerendered `head()` runs against a placeholder request origin — pass the
  canonical origin to `hreflang()` on SSG/ISG routes instead of `url.origin`,
  or the alternates bake in `http://localhost`.
- Update the sitemap to include every per-locale URL (see `/audit-seo`).
- Strategy B only: one URL means one indexed language, whatever the crawler's
  `Accept-Language` resolves to. Say that out loud — if it matters, that is the
  argument for strategy A. Still set `lang`; sitemap entries stay as-is.

## Step 7: Verify

Run `pracht typegen` if step 4 changed route paths or added the API route, and
add `pracht typegen --check` to CI. Boot `pracht dev`, then:

- **Strategy A.** `curl -i` the unprefixed detector with `Accept-Language: fr`
  (302 to `/fr/...`), with a `pracht_locale` cookie (cookie beats header), and
  with garbage (`;q=`, unknown tags → default locale). On a locale-prefixed
  page, confirm translated content and hreflang links. On SSR, confirm
  `Set-Cookie` on first visit and `Vary: Cookie` whether or not the request
  cookie already matches. On SSG/ISG, confirm the stored response has neither
  `Set-Cookie` nor a path-only `Vary`, that hydration writes the locale cookie,
  and that the unprefixed detector then returns to that locale. `/zz/about`
  must 404.
- **Strategy B.** `curl -i` the page with `Accept-Language: fr` (French
  content, `Vary: Cookie, Accept-Language`, no `Set-Cookie`), and with
  `Cookie: pracht_locale=fr` plus `Accept-Language: en` (cookie wins).
  `curl -i -X POST` the switcher with `-d locale=fr` and an `Origin` header
  matching the host (mutation API routes are same-origin-checked): expect 303 +
  `Set-Cookie`. Post an unregistered locale and an off-origin `next`: expect
  400 and a same-origin redirect. In the browser, switch and confirm the URL
  never changes.
- `pnpm test`, `pnpm e2e`, and `pracht verify --json` all pass.

## Rules

1. The middleware sets `context.locale`; loaders read it. Never stash the
   locale in module-level state — concurrent requests collide.
2. Only registered locales may reach paths, cookies, or hreflang.
   `defineI18n`/`localePath` enforce that; never bypass them with string
   concatenation on user input.
3. `Accept-Language` handling is already conservative and must stay that way:
   wildcard fallbacks resolve through the registered locale list, explicit
   `q=0` exclusions hold against both lookup truncation and best-fit fallback,
   directly matched longer variants win before same-language best fit (which
   never crosses conflicting script subtags), and an entry cut in half by the
   defensive header-length limit is discarded rather than parsed with an
   implied quality of 1.
4. For SSG with dynamic segments, `getStaticPaths` must return the locale ×
   dynamic-param product — prerender only URL combinations that exist.
5. Format dates and numbers with `Intl.DateTimeFormat`/`Intl.NumberFormat` and
   `data.locale`; no library needed.
6. Never bundle every translation into the client. `createDictionaries` loaders
   are per-locale lazy imports resolved in loaders — keep them that way.
7. Never move an existing app's URLs without asking. If the user says their
   URLs are fixed, strategy B is the answer, not a redirect table.

$ARGUMENTS
