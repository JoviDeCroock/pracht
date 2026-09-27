---
title: Internationalization (i18n)
lead: Serve your app in multiple languages with @pracht/i18n — middleware detects the locale, loaders return translations, and components consume them via route data.
breadcrumb: i18n
prev:
  href: /docs/coding-agents
  title: Coding Agents
next:
  href: /docs/recipes/auth
  title: Authentication
---

## Strategy Overview

`@pracht/i18n` follows one pattern:

1. **Middleware** detects the locale from the URL prefix, a cookie, or `Accept-Language`.
2. **Loaders** load the dictionary for that locale and return it as route data.
3. **Components** translate with `t()` / `tPlural()`, on the server and after hydration.

It is typed plumbing, not a translation framework: detection middleware, lazy per-locale dictionaries typed from your default locale, `Intl.PluralRules` plurals, and an `hreflang` helper. To own every line instead, see the [hand-rolled recipe](#appendix-the-hand-rolled-recipe).

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
| Caching | `render: "ssg"`/`"isg"` per locale; shared output keys on the URL, while SSR also varies on `Cookie` | SSR only: responses carry `Vary: Cookie, Accept-Language` |
| Cost of adopting | every URL changes | nothing changes |

Take strategy A for public, indexable content, and when starting fresh. Take strategy B when the URLs already exist and cannot move, or the app sits behind a login: it keeps one URL per page and switches without navigating.

Both use the same detection order (`["path", "cookie", "header"]`), so one app can mix them.

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

Dictionaries load lazily per locale and merge over the default locale, so a key missing from `fr` renders the English string. Keys are typed from the default locale: `t(messages, "home.titel")` is a compile error.

---

## 2. Wire the Detection Middleware

The manifest expects a module exporting `middleware`; re-export the instance's:

```ts [src/middleware/i18n.ts]
import { i18n } from "../i18n/index.ts";

export const middleware = i18n.middleware;
```

The middleware sets `context.locale`. When the URL prefix chose the locale, it also remembers it in a `pracht_locale` cookie (one year, `SameSite=Lax`), on SSR and SPA routes only. Configure the cookie with `defineI18n({ cookie: { … } })`, or disable it with `cookie: false`.

Responses vary on `Cookie` and `Accept-Language` when detection read them, so a shared cache never serves one visitor's locale to another.

Only registered locales can win. `Accept-Language` matching follows RFC 4647 lookup (`fr-CA` → `fr`), then a same-language best fit (`en-GB` → a registered `en-US`), and honours `q=0` exclusions. The [i18n reference](/docs/reference/i18n) has the full rules.

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

Use one `pathPrefix` group per locale, so **only registered locales produce URLs**: `/zz/about` is a 404. A `/:locale/about` param route cannot guarantee that, since it matches any first segment.

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

The detector route reads the locale the middleware resolved (cookie first, then `Accept-Language`) and redirects. `return` the redirect rather than throwing it: a thrown `Response` skips the middleware's `Vary` headers, so a shared cache could replay one visitor's redirect to everyone.

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

`localePath()` swaps the locale prefix and keeps the rest of the path, query, and hash. It throws on unregistered locales, so user input never ends up in a URL. `splitLocale()` goes the other way, returning the locale prefix and the rest of the path.

```tsx [src/components/LanguageSwitcher.tsx]
import { useLocation } from "@pracht/core";
import { i18n, type AppLocale } from "../i18n/index.ts";
import { useEffect } from "preact/hooks";

const labels: Record<AppLocale, string> = { en: "English", fr: "Français" };

export function LanguageSwitcher({ currentLocale }: { currentLocale: AppLocale }) {
  const { pathname, search } = useLocation();

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
          href={i18n.localePath(`${pathname}${search}`, locale)}
          class={locale === currentLocale ? "active" : ""}
        >
          {labels[locale]}
        </a>
      ))}
    </nav>
  );
}
```

On SSR routes the middleware refreshes the locale cookie when the visitor switches prefix. SSG/ISG responses cannot carry a per-visitor cookie, so the hydrated switcher above writes it. Without JavaScript a prerendered page cannot persist the choice; if that matters, keep localized pages SSR or add platform edge middleware.

---

## 4. Strategy B — One URL Per Page

If your URLs are fixed, keep them and let the locale live in the cookie. Register routes as usual and add the i18n middleware to the group:

<!-- snippet: partial -->
```ts [src/routes.ts]
group({ shell: "main", middleware: ["i18n"] }, [
  route("/", "./routes/home.tsx", { render: "ssr" }),
  route("/about", "./routes/about.tsx", { render: "ssr" }),
]);
```

Detection now reads the cookie, then `Accept-Language`, and responses carry `Vary: Cookie, Accept-Language`. These routes are per-request: keep them `render: "ssr"` (or `"spa"`), not `"ssg"`/`"isg"`.

With no URL prefix to persist, the switcher writes the cookie. Two ways, and they compose:

**Server switch (works without JavaScript).** An API route sets the cookie and redirects back to the same URL. A hydrated `<Form>` follows the redirect and re-runs the loader:

```ts [src/api/locale.ts]
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

```tsx [src/components/LanguageSwitcher.tsx]
import { Form, useLocation } from "@pracht/core";
import { i18n } from "../i18n/index.ts";

export function LanguageSwitcher({ onSwitchStart }: { onSwitchStart?: () => void }) {
  const { pathname, search } = useLocation();
  return (
    <Form
      method="post"
      action="/api/locale"
      aria-label="Language switcher"
      onSubmit={onSwitchStart}
    >
      <input type="hidden" name="next" value={`${pathname}${search}`} />
      {i18n.locales.map((locale) => (
        <button key={locale} type="submit" name="locale" value={locale}>
          {locale}
        </button>
      ))}
    </Form>
  );
}
```

`localeCookie(locale, { url })` builds the same cookie the middleware reads, with `Secure` inferred from the request URL. Pass `null` to clear it and return to automatic detection.

**Client switch (no request at all).** Write the cookie from the browser and swap the dictionary in place. The URL does not change and nothing is re-fetched:

```tsx
import type { RouteComponentProps } from "@pracht/core";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { t } from "@pracht/i18n";
import { LanguageSwitcher } from "../components/LanguageSwitcher.tsx";
import { dictionaries, i18n, type AppLocale } from "../i18n/index.ts";

export function Component({ data }: RouteComponentProps<typeof loader>) {
  const [override, setOverride] = useState<typeof data.messages | null>(null);
  const switchRequest = useRef(0);
  // Loader data wins again whenever it changes.
  useLayoutEffect(() => {
    setOverride(null);
    return () => {
      // Cleanup runs during the loader-data commit, before a pending import can
      // resume and write a stale cookie, and synchronously on unmount.
      switchRequest.current += 1;
    };
  }, [data.messages]);
  const messages = override ?? data.messages;

  async function switchTo(locale: AppLocale) {
    const request = ++switchRequest.current;
    try {
      const loaded = await dictionaries.load(locale);
      // Lazy chunks can finish out of order. Only the latest successful choice
      // may update the cookie and rendered dictionary.
      if (request !== switchRequest.current) return;
      i18n.setLocaleCookie(locale);
      setOverride(loaded);
    } catch (error: unknown) {
      if (request === switchRequest.current) {
        console.error(`[pracht] Failed to load the ${locale} dictionary.`, error);
      }
    }
  }

  const title = t(messages, "home.title");

  // `head()` runs on the server only: any locale change that does not reload
  // the document has to keep <html lang> and <title> in sync itself.
  useEffect(() => {
    document.documentElement.lang = messages.$locale;
    document.title = title;
  }, [messages.$locale, title]);

  return (
    <>
      <LanguageSwitcher
        onSwitchStart={() => {
          // A server-backed choice supersedes every pending client import.
          switchRequest.current += 1;
        }}
      />
      <h1 onDblClick={() => void switchTo("fr")}>{title}</h1>
    </>
  );
}
```

`dictionaries.load()` works in the browser too; each locale is its own lazy chunk. `i18n.detectClient()` resolves the locale in the browser in the same order, from `location.pathname`, `document.cookie`, and `navigator.languages`.

Invalidate pending client loads synchronously when a server-backed switch or navigation starts, as the form callback above does. Keep the cleanup in `useLayoutEffect`: a passive effect runs after paint, so an older import could still write a stale cookie.

> [!NOTE]
> One URL per page cannot express `hreflang`, since there is no alternate URL. Skip `i18n.hreflang()`; search engines index one language. If indexable multilingual content matters more than keeping URLs, use strategy A.

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
  useEffect(() => {
    i18n.setLocaleCookie(data.locale);
  }, [data.locale]);
  return (
    <div>
      <h1>{t(data.messages, "home.title")}</h1>
      <p>{t(data.messages, "home.lead", { name: "Jovi" })}</p>
      <p>{tPlural(data.messages, "cart.items", data.itemCount)}</p>
    </div>
  );
}
```

`t()` fills `{param}` placeholders in one pass, inserting values verbatim. `tPlural()` picks `<key>.<category>` via `Intl.PluralRules` for the dictionary's locale and falls back to `<key>.other`. Add `.few`/`.many` keys for locales such as Polish.

`messages` is plain JSON, so the same `t()` calls work after hydration and on client navigations.

---

## Tips

- **Prerendering.** Locale-prefixed routes can be `render: "ssg"` or `"isg"`; each locale prerenders. Keep `"path"` first in `detect` for them: a prerendered route that depends on cookie or header detection gets `Vary: Cookie`, and the ISG cache refuses it.
- **Keep the detector route SSR.** Its answer depends on the visitor's cookie and headers, which prerender and ISG-revalidation requests do not carry.
- On SSG/ISG routes, pass your canonical origin to `hreflang()` (`{ origin: "https://example.com" }`). At prerender time `url.origin` is a placeholder (`http://localhost`) that would be baked into the page.
- `hreflang()` keeps a path's query and hash on every alternate, including `x-default`.
- Set `lang` and the localized title in `head()`. `head()` runs on the server, so the strategy B client switch must update `document.documentElement.lang` and `document.title` itself.
- Format dates and numbers with `Intl.DateTimeFormat` / `Intl.NumberFormat` and `data.locale`.
- [`examples/basic`](https://github.com/JoviDeCroock/pracht/tree/main/examples/basic) runs both on one i18n instance: strategy A under `/welcome` and strategy B under `/greeting`.

---

## Appendix: the Hand-Rolled Recipe

If you prefer zero dependencies, the pattern is a page of code. Middleware stores the locale on the context; loaders read it:

```ts [src/i18n/index.ts]
import en from "./en";
import fr from "./fr";

export const translations = { en, fr } as const;
export const defaultLocale = "en";
export const supportedLocales = Object.keys(translations);

export function t(locale: string, key: keyof typeof en & string): string {
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

The hand-rolled version leaves the edge cases to you: q-value ordering, malformed headers, cookie persistence, canonical casing, and refusing unregistered locales wherever they could reach a path or cookie.
