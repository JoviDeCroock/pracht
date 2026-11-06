---
title: Internationalization (i18n)
lead: "Serve several languages with `@pracht/i18n`: middleware detects the locale, loaders return translations, and components read them."
---

This recipe serves an app in English and French. Middleware detects the locale from the URL prefix, a cookie, or `Accept-Language`; loaders return that locale's dictionary; components translate with `t()` and `tPlural()`, on the server and after hydration.

`@pracht/i18n` covers detection, lazy dictionaries typed from your default locale, `Intl.PluralRules` plurals, and `hreflang` links. The [i18n reference](/docs/reference/i18n) lists every option. To write the plumbing yourself, see [Hand-rolled alternative](#hand-rolled-alternative).

## Choose a URL strategy

Steps 1 to 4 are the same for both strategies. They differ in whether the locale is part of the URL:

| Concern | A. Locale-prefixed URLs (`/en/about`, `/fr/about`) | B. One URL per page (`/about`) |
| --- | --- | --- |
| Locale comes from | The path (cookie or header only on unprefixed entry points) | The cookie, then `Accept-Language` |
| Switching | Navigate to the other prefix | Write the cookie (form post or client-side) |
| SEO | Each language is its own indexable URL; `hreflang` alternates work | One indexable URL; crawlers see whatever their `Accept-Language` resolves to |
| Caching | `ssg`/`isg` per locale; SSR also varies on `Cookie` | SSR only; responses carry `Vary: Cookie, Accept-Language` |
| Cost of adopting | Every URL changes | Nothing changes |

Choose A for public, indexable content and new apps. Choose B when the URLs already exist and cannot move, or the app sits behind a login. Both use the same detection order, so one app can mix them.

## 1. Install

```bash
npm install @pracht/i18n
```

## 2. Define locales and dictionaries

Create one i18n instance for the app and one dictionary module per locale (flat string keys, default export):

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

Each locale loads as its own lazy chunk and merges over the default locale, so a key missing from `fr` renders the English string. Keys are typed from the default locale: `t(messages, "home.titel")` is a compile error.

## 3. Wire the detection middleware

Re-export the instance's middleware from a middleware module:

```ts [src/middleware/i18n.ts]
import { i18n } from "../i18n/index.ts";

export const middleware = i18n.middleware;
```

The middleware sets `context.locale`. Only registered locales can win; `Accept-Language: fr-CA` resolves to `fr`. When the URL prefix chose the locale on an SSR or SPA route, the middleware also remembers it in a `pracht_locale` cookie (one year, `SameSite=Lax`). Configure the cookie with `defineI18n({ cookie: { … } })`, or disable it with `cookie: false`.

Responses vary on `Cookie` and `Accept-Language` when detection read them, so a shared cache never serves one visitor's locale to another.

Type `context.locale` once through the `Register` interface:

```ts [src/env.d.ts]
import type { I18nRequestContext } from "@pracht/i18n";

declare module "@pracht/core" {
  interface Register {
    context: I18nRequestContext<"en" | "fr">;
  }
}
```

## 4. Translate in a route

Load the dictionary in the loader and translate in the component:

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
    // Strategy A only: one alternate link per locale plus x-default.
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

The French page renders "Bienvenue sur Mon App" and "3 articles", with `<html lang="fr">`.

- `t()` fills `{param}` placeholders and inserts values verbatim.
- `tPlural()` picks `<key>.<category>` with `Intl.PluralRules` for the dictionary's locale, falling back to `<key>.other`. Add `.few` and `.many` keys for locales such as Polish.
- `messages` is plain JSON, so the same calls work after hydration and on client navigations.
- Format dates and numbers with `Intl.DateTimeFormat` and `Intl.NumberFormat`, passing `data.locale`.

## 5. Strategy A: locale-prefixed routes

Register one `pathPrefix` group per locale, so only registered locales produce URLs and `/zz/about` is a 404. A `/:locale/about` param route cannot guarantee that, since it matches any first segment.

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
> Route matching is exact, so locale prefixes are lowercase URLs. Build links with `i18n.localePath()` to keep them canonical. If you set explicit route `id`s, reusing one `localizedRoutes` array needs unique ids per locale.

The detector route redirects to the locale the middleware resolved from the cookie or `Accept-Language`. Visiting `/` with `Accept-Language: fr` lands on `/fr`.

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

Return the redirect rather than throwing it: a thrown `Response` skips the middleware's `Vary` headers, so a shared cache could replay one visitor's redirect to everyone. Keep the detector `ssr`, because its answer depends on headers that prerender requests do not carry.

### Language switcher

`localePath()` swaps the locale prefix and keeps the rest of the path, query, and hash. It throws on unregistered locales, so user input never ends up in a URL.

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

Without JavaScript, a prerendered page cannot persist the choice. If that matters, keep localized pages `ssr`.

### Prerender localized pages

Locale-prefixed routes can be `render: "ssg"` or `"isg"`, and each locale prerenders. Keep `"path"` first in `detect`: a prerendered route that depends on cookie or header detection gets `Vary: Cookie`, and the ISG cache refuses it.

Pass your canonical origin to `hreflang()`. At prerender time `url.origin` is `http://localhost`, which would be baked into the page.

## 6. Strategy B: one URL per page

Keep your URLs and add the i18n middleware to the group:

<!-- snippet: partial -->
```ts [src/routes.ts]
group({ shell: "main", middleware: ["i18n"] }, [
  route("/", "./routes/home.tsx", { render: "ssr" }),
  route("/about", "./routes/about.tsx", { render: "ssr" }),
]);
```

Detection reads the cookie, then `Accept-Language`, and responses carry `Vary: Cookie, Accept-Language`. Keep these routes `ssr` or `spa`, not `ssg` or `isg`.

Drop the `hreflang()` line from `head()`: with one URL per page there is no alternate URL, and search engines index one language. If indexable multilingual content matters more than keeping URLs, use strategy A.

With no URL prefix, the switcher writes the cookie. The two ways below compose.

### Switch on the server

An API route sets the cookie and redirects back to the same URL. This works without JavaScript, and a hydrated `<Form>` follows the redirect and re-runs the loader.

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

`localeCookie(locale, { url })` builds the cookie the middleware reads, with `Secure` inferred from the request URL. Pass `null` instead of a locale to clear it and return to automatic detection.

### Switch on the client

Write the cookie from the browser and swap the dictionary in place. The URL does not change and nothing is fetched except the dictionary chunk:

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

- `i18n.detectClient()` resolves the locale in the browser in the same order, from `location.pathname`, `document.cookie`, and `navigator.languages`.
- Invalidate pending client loads synchronously when a server-backed switch or navigation starts, as `onSwitchStart` does above.
- Keep the cleanup in `useLayoutEffect`. A passive effect runs after paint, so an older import could still write a stale cookie.

[`examples/basic`](https://github.com/JoviDeCroock/pracht/tree/main/examples/basic) runs both strategies on one i18n instance: A under `/welcome` and B under `/greeting`.

## Hand-rolled alternative

The same pattern without the package is a page of code. Middleware stores the locale on the context, and loaders read it:

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

This version leaves the edge cases to you: q-value ordering, malformed headers, cookie persistence, canonical casing, `Vary` headers, and refusing unregistered locales wherever they could reach a path or cookie.
