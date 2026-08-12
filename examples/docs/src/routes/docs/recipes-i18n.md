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

Only registered locales can ever win: unregistered URL prefixes and cookie values are ignored, malformed `Accept-Language` entries (`;q=`, garbage tags) are dropped, and matching follows RFC 4647 lookup (`fr-CA` → `fr`, `zh-Hant-TW` → `zh-Hant`) with a same-language best fit (`en-GB` → a registered `en-US`) before falling through to lower-preference entries.

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

## 3. Wire Routes with Locale Prefixes

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

## 4. Load Translations in Your Loader

```tsx [src/routes/home.tsx]
import type { HeadArgs, LoaderArgs, RouteComponentProps } from "@pracht/core";
import { t, tPlural } from "@pracht/i18n";
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

## 5. Language Switcher

`localePath()` swaps the locale prefix while preserving the rest of the path, query, and hash — and throws on unregistered locales, so user input can never be reflected into a URL:

```tsx [src/components/LanguageSwitcher.tsx]
import { useLocation } from "@pracht/core";
import { i18n, type AppLocale } from "../i18n/index.ts";

const labels: Record<AppLocale, string> = { en: "English", fr: "Français" };

export function LanguageSwitcher({ currentLocale }: { currentLocale: AppLocale }) {
  const { pathname } = useLocation();

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

Navigating to the other prefix is an explicit choice, so the middleware refreshes the locale cookie and unprefixed entry points remember it.

---

## Tips

- **SSG/ISG**: locale-prefixed routes can be `render: "ssg"` or `"isg"` — every prefixed URL is a real route, so each locale prerenders, and the middleware skips cookie persistence on prerenderable routes so no `Set-Cookie` ever lands in stored output. Keep the *detector* route SSR: its answer depends on the visitor's cookie/headers, and cookie/header detection cannot run against a stored document (prerender and ISG-revalidation requests carry no cookies or `Accept-Language`). For prerendered routes, keep `"path"` first in the detect order — a prerendered route that *depends* on cookie/header detection gets `Vary: Cookie` and is refused by the ISG cache rather than serving one visitor's locale to everyone.
- On SSG/ISG routes, pass your canonical origin to `hreflang()` (`{ origin: "https://example.com" }`) — `url.origin` at prerender time is a placeholder (`http://localhost`) and would be baked into the static document.
- Set `lang` from the resolved locale in `head()` (as above) so browsers and screen readers know the language.
- Use `Intl.DateTimeFormat` / `Intl.NumberFormat` with `data.locale` for dates and numbers — no library needed.
- A working end-to-end setup (two locales, detector redirect, hreflang, cookie override, plural rendering) lives in [`examples/basic`](https://github.com/JoviDeCroock/pracht/tree/main/examples/basic) under `/welcome`.

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
