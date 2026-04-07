---
title: Internationalization (i18n)
lead: Serve your app in multiple languages using middleware for locale detection, loaders for translated content, and context for passing the active locale through your app.
breadcrumb: i18n
prev:
  href: /docs/performance
  title: Performance
next:
  href: /docs/recipes/auth
  title: Authentication
---

## Strategy Overview

Viact doesn't ship a built-in i18n library — instead it gives you the primitives to wire any translation approach. The recommended pattern:

1. **Middleware** detects the locale from the URL, cookie, or `Accept-Language` header.
2. **Loaders** load the right translation strings for the matched locale.
3. **Components** consume translations via route data.

---

## 1. Define Your Translations

Keep translation files as plain JSON or TypeScript objects. A simple flat-key structure works well:

```ts [src/i18n/en.ts]
export default {
  "home.title": "Welcome to My App",
  "home.subtitle": "Built with viact",
  "nav.home": "Home",
  "nav.about": "About",
  "nav.pricing": "Pricing",
} as const;
```

```ts [src/i18n/fr.ts]
export default {
  "home.title": "Bienvenue sur Mon App",
  "home.subtitle": "Construit avec viact",
  "nav.home": "Accueil",
  "nav.about": "\u00C0 propos",
  "nav.pricing": "Tarifs",
} as const;
```

```ts [src/i18n/index.ts]
import en from "./en";
import fr from "./fr";

export const translations: Record<string, Record<string, string>> = { en, fr };
export const defaultLocale = "en";
export const supportedLocales = Object.keys(translations);

export function t(locale: string, key: string): string {
  return translations[locale]?.[key] ?? translations[defaultLocale]?.[key] ?? key;
}
```

---

## 2. Locale Detection Middleware

Create middleware that detects the locale and makes it available to loaders. You can detect from a URL prefix, a cookie, or the `Accept-Language` header.

### URL-prefix strategy

The cleanest approach for SEO — each locale has its own URL namespace like `/fr/about` or `/en/about`.

```ts [src/middleware/i18n.ts]
import type { MiddlewareFn } from "viact";
import { supportedLocales, defaultLocale } from "../i18n";

export const middleware: MiddlewareFn = async ({ request, url }) => {
  // Extract locale from first URL segment: /fr/about -> "fr"
  const segments = url.pathname.split("/").filter(Boolean);
  const maybeLocale = segments[0];

  if (supportedLocales.includes(maybeLocale)) {
    // Locale found in URL — pass it through via headers
    request.headers.set("x-locale", maybeLocale);
    return;
  }

  // No locale in URL — detect from Accept-Language or default
  const accept = request.headers.get("accept-language") ?? "";
  const preferred = accept
    .split(",")
    .map((part) => part.split(";")[0].trim().slice(0, 2))
    .find((lang) => supportedLocales.includes(lang));

  const locale = preferred ?? defaultLocale;

  // Redirect to prefixed URL
  return { redirect: `/${locale}${url.pathname}` };
};
```

### Cookie-based strategy

If you prefer clean URLs without a locale prefix, store the preference in a cookie:

```ts [src/middleware/i18n.ts]
import type { MiddlewareFn } from "viact";
import { supportedLocales, defaultLocale } from "../i18n";

export const middleware: MiddlewareFn = async ({ request }) => {
  const cookies = request.headers.get("cookie") ?? "";
  const match = cookies.match(/locale=(\w+)/);
  const locale = match && supportedLocales.includes(match[1])
    ? match[1]
    : defaultLocale;

  request.headers.set("x-locale", locale);
};
```

---

## 3. Load Translations in Your Loader

Read the locale set by middleware and return the translated content:

```ts [src/routes/home.tsx]
import type { LoaderArgs, RouteComponentProps } from "viact";
import { t } from "../i18n";

export async function loader({ request }: LoaderArgs) {
  const locale = request.headers.get("x-locale") ?? "en";
  return {
    locale,
    title: t(locale, "home.title"),
    subtitle: t(locale, "home.subtitle"),
  };
}

export function head({ data }: { data: Awaited<ReturnType<typeof loader>> }) {
  return {
    title: data.title,
    meta: [{ property: "og:locale", content: data.locale }],
    link: [{ rel: "alternate", hreflang: "fr", href: "/fr/" }],
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <div>
      <h1>{data.title}</h1>
      <p>{data.subtitle}</p>
    </div>
  );
}
```

---

## 4. Wire Routes with Locale Prefix

Use `group` with `pathPrefix` to create locale-scoped route groups:

```ts [src/routes.ts]
import { defineApp, group, route } from "viact";

const localizedRoutes = [
  route("/", "./routes/home.tsx", { render: "ssr" }),
  route("/about", "./routes/about.tsx", { render: "ssg" }),
  route("/pricing", "./routes/pricing.tsx", { render: "ssg" }),
];

export const app = defineApp({
  shells: { main: "./shells/main.tsx" },
  middleware: { i18n: "./middleware/i18n.ts" },
  routes: [
    group({ shell: "main", middleware: ["i18n"] }, [
      // Each locale gets its own prefix
      group({ pathPrefix: "/en" }, localizedRoutes),
      group({ pathPrefix: "/fr" }, localizedRoutes),

      // Root redirects to detected locale
      route("/", "./routes/locale-redirect.tsx", { render: "ssr" }),
    ]),
  ],
});
```

---

## 5. Language Switcher Component

A simple component that links to the same page in a different locale:

```ts [src/components/LanguageSwitcher.tsx]
import { useLocation } from "viact";
import { supportedLocales } from "../i18n";

const labels: Record<string, string> = { en: "English", fr: "Fran\u00E7ais" };

export function LanguageSwitcher({ currentLocale }: { currentLocale: string }) {
  const { pathname } = useLocation();

  // Replace the locale segment in the current path
  const switchTo = (locale: string) => {
    const withoutLocale = pathname.replace(/^\/(en|fr)/, "");
    return `/${locale}${withoutLocale || "/"}`;
  };

  return (
    <nav class="lang-switcher">
      {supportedLocales.map((locale) => (
        <a
          key={locale}
          href={switchTo(locale)}
          class={locale === currentLocale ? "active" : ""}
        >
          {labels[locale]}
        </a>
      ))}
    </nav>
  );
}
```

---

## Tips

- For **SSG** pages, use `prerender()` to generate a page per locale:

```ts
export async function prerender() {
  return ["/en/about", "/fr/about"];
}
```

- Set the `lang` attribute on your shell's root element so browsers and screen readers know the language.
- For large apps, lazy-load translation files in your loader instead of importing everything upfront.
- For type-safe keys, use `keyof typeof en` as your translation key type.
