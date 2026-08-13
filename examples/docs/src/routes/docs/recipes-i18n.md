---
title: Internationalization (i18n)
lead: Serve your app in multiple languages with @pracht/i18n — middleware detects the locale, loaders return translations, and components consume them via route data.
breadcrumb: i18n
prev:
  href: /docs/remote-mcp
  title: Remote MCP
next:
  href: /docs/recipes/auth
  title: Authentication
---

## Strategy Overview

Pracht's i18n story follows one pattern, now packaged as `@pracht/i18n`:

1. **Middleware** detects the locale from the URL prefix, a cookie, or `Accept-Language`.
2. **Loaders** load the right dictionary for the resolved locale and return it as route data.
3. **Components** translate with `t()` / `tPlural()` — on the server and after hydration, since the loaded dictionary is a plain serializable object.

`@pracht/i18n` is deliberately not a translation framework — it is the typed plumbing: detection middleware, lazy per-locale dictionaries with keys typed from your default locale, plural selection via `Intl.PluralRules`, and an `hreflang` helper for `head()`. If you would rather own every line, the [hand-rolled recipe](#appendix-the-hand-rolled-recipe) below still works.

```bash
npm install @pracht/i18n
```

### Two URL strategies

Steps 1, 2 and 5 are the same either way. What differs is whether the locale is part of the URL:

| Concern | **A. Locale-prefixed URLs** (`/en/about`, `/fr/about`) | **B. One URL per page** (`/about`) |
| --- | --- | --- |
| Locale comes from | the path (cookie/header only on unprefixed entry points) | the cookie, falling back to `Accept-Language` |
| Switching | navigate to the other prefix | write the cookie (form post, or client-side) |
| SEO | each language is its own indexable URL; `hreflang` alternates work | one indexable URL — crawlers see whatever their `Accept-Language` resolves to |
| Caching | `render: "ssg"`/`"isg"` per locale; shared caches key on the URL | SSR only: responses carry `Vary: Cookie, Accept-Language` |
| Cost of adopting | every URL changes | nothing changes |

Strategy A is the better default for public, indexable content — if you are starting fresh, take it. Strategy B is the answer when the URLs already exist and cannot move (or when the app is behind a login, where indexing does not matter): it keeps one URL per page and switches with no navigation at all.

The detection order is the same in both (`["path", "cookie", "header"]`), so you can mix them in one app: the path source simply never matches on a prefix-free route.

---

## 1. Define Locales and Dictionaries

Keep one i18n instance per app, plus one dictionary module per locale (flat string keys, default export):

```ts [src/i18n/index.ts]
import { createDictionaries, defineI18n } from "@pracht/i18n";

export const i18n = defineI18n({
  locales: ["en", "fr"],
  defaultLocale: "en",
  // Detection order (this is the default): explicit URL prefix beats the
  // remembered cookie beats the browser's Accept-Language header.
  detect: ["path", "cookie", "header"],
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

```ts [src/i18n/locales/en.ts]
export default {
  "home.title": "Welcome to My App",
  "home.lead": "Built with pracht, {name}",
  "cart.items.one": "{count} item",
  "cart.items.other": "{count} items",
} as const;
```

```ts [src/i18n/locales/fr.ts]
export default {
  "home.title": "Bienvenue sur Mon App",
  "home.lead": "Construit avec pracht, {name}",
  "cart.items.one": "{count} article",
  "cart.items.other": "{count} articles",
} as const;
```

Dictionaries load lazily per locale on the server and are merged over the default locale, so a key missing from `fr` renders the English string instead of breaking. Keys are typed from the default locale's shape — `t(messages, "home.titel")` is a compile error.

---

## 2. Wire the Detection Middleware

The manifest expects a module exporting `middleware`; re-export the instance's:

```ts [src/middleware/i18n.ts]
import { i18n } from "../i18n/index.ts";

export const middleware = i18n.middleware;
```

The middleware resolves the locale via the configured detection order, sets `context.locale` for loaders, and — when the URL prefix chose the locale — persists it in a cookie (`pracht_locale`, `Path=/`, `SameSite=Lax`, one year, `Secure` on https). Persistence only happens on per-request (SSR/SPA) routes: SSG/ISG output is stored and replayed to every visitor, so the middleware never attaches `Set-Cookie` there. It also appends `Vary: Cookie` / `Vary: Accept-Language` when those detection sources were consulted, so a shared cache in front of the app keys on them.

Only registered locales can ever win: unregistered URL prefixes and cookie values are ignored, malformed `Accept-Language` entries (`;q=`, `q=0.5junk`, garbage tags) are dropped, wildcard fallbacks are checked against the locale registry, and matching follows RFC 4647 lookup (`fr-CA` → `fr`, `zh-Hant-TW` → `zh-Hant`) with a same-language best fit (`en-GB` → a registered `en-US`) before falling through to lower-preference entries.

Type `context.locale` once via the framework's `Register` pattern:

```ts [src/env.d.ts]
import type { I18nRequestContext } from "@pracht/i18n";

declare module "@pracht/core" {
  interface Register {
    context: I18nRequestContext<"en" | "fr">;
  }
}
```

---

## 3. Strategy A — Locale-Prefixed Routes

Use one `pathPrefix` group per locale — this works with today's router and means **only registered locales produce URLs**: `/zz/about` is a plain 404, never duplicate default-locale content at a bogus URL (a `/:locale/about` param route cannot make that guarantee — it matches any first segment).

```ts [src/routes.ts]
import { defineApp, group, route } from "@pracht/core";

const localizedRoutes = [
  route("/", "./routes/home.tsx", { render: "ssr" }),
  route("/about", "./routes/about.tsx", { render: "ssr" }),
];

export const app = defineApp({
  shells: { main: "./shells/main.tsx" },
  middleware: { i18n: "./middleware/i18n.ts" },
  routes: [
    group({ shell: "main", middleware: ["i18n"] }, [
      group({ pathPrefix: "/en" }, localizedRoutes),
      group({ pathPrefix: "/fr" }, localizedRoutes),

      // Unprefixed detector: redirects to the visitor's locale.
      route("/", "./routes/locale-redirect.tsx", { render: "ssr" }),
    ]),
  ],
});
```

> [!NOTE]
> Route matching is exact, so locale prefixes are lowercase URLs. Build links with `i18n.localePath()` and they always come out canonical. Reusing one `localizedRoutes` array between prefixes needs unique route ids per locale if you set explicit `id`s.

The detector route reads the locale the middleware already resolved (cookie first for returning visitors, then `Accept-Language`) and forwards. `return` the redirect rather than throwing it: a thrown `Response` short-circuits past the middleware chain, so the i18n middleware could not stamp `Vary: Cookie, Accept-Language` on it — and a shared cache could then replay one visitor's locale redirect to everyone:

```tsx [src/routes/locale-redirect.tsx]
import { redirect, type LoaderArgs } from "@pracht/core";
import { i18n } from "../i18n/index.ts";

export async function loader({ context, request }: LoaderArgs) {
  return redirect(i18n.localePath("/", context.locale), { request });
}

export function Component() {
  return null; // never rendered — the loader always redirects
}
```

---

### Language switcher

`localePath()` swaps the locale prefix while preserving the rest of the path, query, and hash — and throws on unregistered locales, so user input can never be reflected into a URL:

```tsx [src/components/LanguageSwitcher.tsx]
import { useLocation } from "@pracht/core";
import { i18n, type AppLocale } from "../i18n/index.ts";
import { useEffect } from "preact/hooks";

const labels: Record<AppLocale, string> = { en: "English", fr: "Français" };

export function LanguageSwitcher({ currentLocale }: { currentLocale: AppLocale }) {
  const { pathname } = useLocation();

  // SSG/ISG responses are shared and cannot set a visitor-specific cookie.
  // Persist the explicit prefix after hydration so the SSR detector remembers
  // it later. This is harmless on SSR pages where middleware already did so.
  useEffect(() => {
    i18n.setLocaleCookie(currentLocale);
  }, [currentLocale]);

  return (
    <nav class="lang-switcher">
      {i18n.locales.map((locale) => (
        <a
          key={locale}
          href={i18n.localePath(pathname, locale)}
          class={locale === currentLocale ? "active" : ""}
        >
          {labels[locale]}
        </a>
      ))}
    </nav>
  );
}
```

Navigating to the other prefix is an explicit choice. On SSR routes the middleware refreshes the locale cookie; on SSG/ISG routes the hydrated switcher above does it because their stored response cannot safely carry a visitor-specific `Set-Cookie`. Either way, later unprefixed entry points remember the choice once hydration has run. A no-JavaScript visit to a prerendered page cannot persist a cookie; if that requirement matters, keep localized pages SSR or add platform edge middleware before static asset serving.

---

## 4. Strategy B — One URL Per Page

If your URLs are fixed — an existing site, a shared link surface, an app behind a login — keep them and let the locale live in the cookie. Nothing about the manifest changes: register routes as usual and add the i18n middleware to the group.

```ts [src/routes.ts]
group({ shell: "main", middleware: ["i18n"] }, [
  route("/", "./routes/home.tsx", { render: "ssr" }),
  route("/about", "./routes/about.tsx", { render: "ssr" }),
]);
```

Detection now resolves through the cookie (a choice the visitor already made) and then `Accept-Language`, and the middleware stamps `Vary: Cookie, Accept-Language` so a shared cache in front of the app cannot serve one visitor's language to another. That also means these routes are per-request: keep them `render: "ssr"` (or `"spa"`), not `"ssg"`/`"isg"`.

There is no URL prefix to persist, so the switch is what writes the cookie. Two ways, and they compose:

**Server switch (works without JavaScript).** An API route sets the cookie and redirects back to the same URL; `<Form>` intercepts it when hydrated, follows the 303, and re-runs the loader:

```ts [src/api/locale.ts]
import { redirect, type BaseRouteArgs } from "@pracht/core";
import { i18n } from "../i18n/index.ts";

export async function POST({ request, url }: BaseRouteArgs) {
  const form = await request.formData();
  const locale = form.get("locale");
  if (!i18n.isLocale(locale)) return new Response("Unknown locale", { status: 400 });

  // Only bounce back to one of your own paths — `next` is user input.
  const next = form.get("next");
  const target = typeof next === "string" && /^\/(?![/\\])/.test(next) ? next : "/";

  const response = redirect(target, { request, status: 303 });
  response.headers.append("set-cookie", i18n.localeCookie(locale, { url }));
  return response;
}
```

```tsx [src/components/LanguageSwitcher.tsx]
import { Form, useLocation } from "@pracht/core";
import { i18n } from "../i18n/index.ts";

export function LanguageSwitcher() {
  const { pathname } = useLocation();
  return (
    <Form method="post" action="/api/locale" aria-label="Language switcher">
      <input type="hidden" name="next" value={pathname} />
      {i18n.locales.map((locale) => (
        <button key={locale} type="submit" name="locale" value={locale}>
          {locale}
        </button>
      ))}
    </Form>
  );
}
```

`localeCookie(locale, { url })` serializes exactly what the middleware reads — same name, path, `Max-Age`, `SameSite`, and `Secure` inferred from the request URL. `SameSite=None` always forces `Secure`, because browsers otherwise reject the cookie. Pass `null` to clear it and go back to automatic detection.

**Client switch (no request at all).** Write the cookie from the browser and swap the dictionary in place — the URL never changes and nothing is re-fetched:

```tsx
import { useEffect, useState } from "preact/hooks";
import { t } from "@pracht/i18n";
import { dictionaries, i18n, type AppLocale } from "../i18n/index.ts";

export function Component({ data }: RouteComponentProps<typeof loader>) {
  const [override, setOverride] = useState<typeof data.messages | null>(null);
  // Loader data wins again whenever it changes.
  useEffect(() => setOverride(null), [data.locale]);
  const messages = override ?? data.messages;

  async function switchTo(locale: AppLocale) {
    i18n.setLocaleCookie(locale); // remembered for the next server render
    setOverride(await dictionaries.load(locale)); // lazy chunk, then rerender
  }

  // `head()` runs on the server only: any locale change that does not reload
  // the document has to keep <html lang> in sync itself.
  useEffect(() => {
    document.documentElement.lang = messages.$locale;
  }, [messages.$locale]);

  return <h1 onDblClick={() => switchTo("fr")}>{t(messages, "home.title")}</h1>;
}
```

`dictionaries.load()` works in the browser exactly as it does on the server (each locale is its own lazily imported chunk), and `i18n.detectClient()` is the browser-side counterpart of `detect()` — it reads `location.pathname`, `document.cookie`, and `navigator.languages` in the same configured order, which is handy if a client-only surface needs to resolve the locale on its own.

> [!NOTE]
> One URL per page cannot express `hreflang` — there is no alternate URL to point at — so skip `i18n.hreflang()` here and accept that search engines index a single language version. If indexable multilingual content matters more than the URLs, that is the argument for strategy A.

---

## 5. Load Translations in Your Loader

```tsx [src/routes/home.tsx]
import type { HeadArgs, LoaderArgs, RouteComponentProps } from "@pracht/core";
import { t, tPlural } from "@pracht/i18n";
import { useEffect } from "preact/hooks";

import { dictionaries, i18n } from "../i18n/index.ts";

export async function loader({ context }: LoaderArgs) {
  const messages = await dictionaries.load(context.locale);
  return { locale: context.locale, messages, itemCount: 3 };
}

export function head({ data, url }: HeadArgs<typeof loader>) {
  return {
    lang: data.locale,
    title: t(data.messages, "home.title"),
    meta: [{ property: "og:locale", content: data.locale }],
    // One alternate link per locale plus x-default → the detector route.
    link: i18n.hreflang(url.pathname, { origin: "https://example.com" }),
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  // Needed when this localized page is SSG/ISG; harmless on SSR.
  useEffect(() => i18n.setLocaleCookie(data.locale), [data.locale]);
  return (
    <div>
      <h1>{t(data.messages, "home.title")}</h1>
      <p>{t(data.messages, "home.lead", { name: "Jovi" })}</p>
      <p>{tPlural(data.messages, "cart.items", data.itemCount)}</p>
    </div>
  );
}
```

`t()` interpolates `{param}` placeholders in a single pass — a value containing braces is substituted verbatim, never re-interpolated. `tPlural()` picks `<key>.<category>` via `Intl.PluralRules` in the dictionary's locale — declare `.few`/`.many` entries for locales like Polish that need them; anything missing falls back to `<key>.other`.

Because `messages` is plain JSON, it serializes into route data and the exact same `t()` calls work after hydration and on client navigations.

---

## Tips

- **SSG/ISG**: locale-prefixed routes can be `render: "ssg"` or `"isg"` — every prefixed URL is a real route, so each locale prerenders, and the middleware skips cookie persistence on prerenderable routes so no `Set-Cookie` ever lands in stored output. Persist `data.locale` with `setLocaleCookie()` after hydration (as above) if the SSR detector should remember an explicit prefixed visit; without JavaScript, use SSR or platform edge middleware. Keep the *detector* route SSR: its answer depends on the visitor's cookie/headers, and cookie/header detection cannot run against a stored document (prerender and ISG-revalidation requests carry no cookies or `Accept-Language`). For prerendered routes, keep `"path"` first in the detect order — a prerendered route that *depends* on cookie/header detection gets `Vary: Cookie` and is refused by the ISG cache rather than serving one visitor's locale to everyone.
- On SSG/ISG routes, pass your canonical origin to `hreflang()` (`{ origin: "https://example.com" }`) — `url.origin` at prerender time is a placeholder (`http://localhost`) and would be baked into the static document.
- Set `lang` from the resolved locale in `head()` (as above) so browsers and screen readers know the language. `head()` runs on the server, so a locale change that never reloads the document — the client switch in strategy B — must set `document.documentElement.lang` itself.
- Use `Intl.DateTimeFormat` / `Intl.NumberFormat` with `data.locale` for dates and numbers — no library needed.
- A working end-to-end setup lives in [`examples/basic`](https://github.com/JoviDeCroock/pracht/tree/main/examples/basic): strategy A under `/welcome` (two locales, detector redirect, hreflang, cookie override, plural rendering) and strategy B under `/greeting` (one URL, form-post switch via `/api/locale`, client-side switch) — both against a single i18n instance.

---

## Appendix: the Hand-Rolled Recipe

`@pracht/i18n` is a thin layer; if you prefer zero dependencies, the original pattern is a page of code. Middleware stashes the locale on the context (or a request header), loaders read it:

```ts [src/i18n/index.ts]
import en from "./en";
import fr from "./fr";

export const translations = { en, fr } as const;
export const defaultLocale = "en";
export const supportedLocales = Object.keys(translations);

export function t(locale: string, key: keyof typeof en): string {
  const dict = (translations as Record<string, Record<string, string>>)[locale];
  return dict?.[key] ?? translations[defaultLocale][key] ?? key;
}
```

```ts [src/middleware/i18n.ts]
import { redirect, type MiddlewareFn } from "@pracht/core";
import { supportedLocales, defaultLocale } from "../i18n";

export const middleware: MiddlewareFn = async ({ request, url, context }, next) => {
  const maybeLocale = url.pathname.split("/").filter(Boolean)[0] ?? "";

  if (supportedLocales.includes(maybeLocale)) {
    (context as { locale?: string }).locale = maybeLocale;
    return next();
  }

  // Minimal Accept-Language fallback — no q-value ordering.
  const accept = request.headers.get("accept-language") ?? "";
  const preferred = accept
    .split(",")
    .map((part) => part.split(";")[0].trim().slice(0, 2))
    .find((lang) => supportedLocales.includes(lang));

  return redirect(`/${preferred ?? defaultLocale}${url.pathname}`, { request });
};
```

The hand-rolled version is where the package's edge-case handling has to be reimplemented by you: q-value ordering, malformed header entries, cookie persistence and its attributes, canonicalizing case, and refusing unregistered locales everywhere they could reflect into paths or cookies. That checklist is exactly why the package exists.
