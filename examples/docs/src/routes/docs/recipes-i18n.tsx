import { CodeBlock } from "../../components/CodeBlock";

export function head() {
  return { title: "i18n — Recipes — viact docs" };
}

export function Component() {
  return (
    <div class="doc-page">
      <div class="breadcrumb">
        <a href="/">viact</a>
        <span class="breadcrumb-sep">/</span>
        <a href="/docs/getting-started">Docs</a>
        <span class="breadcrumb-sep">/</span>
        <span>i18n</span>
      </div>

      <h1 class="doc-title">Internationalization (i18n)</h1>
      <p class="doc-lead">
        Serve your app in multiple languages using middleware for locale
        detection, loaders for translated content, and context for passing the
        active locale through your app.
      </p>

      <h2>Strategy Overview</h2>
      <p>
        Viact doesn't ship a built-in i18n library — instead it gives you the
        primitives to wire any translation approach. The recommended pattern:
      </p>
      <ol>
        <li>
          <strong>Middleware</strong> detects the locale from the URL, cookie, or{" "}
          <code>Accept-Language</code> header.
        </li>
        <li>
          <strong>Loaders</strong> load the right translation strings for the
          matched locale.
        </li>
        <li>
          <strong>Components</strong> consume translations via route data.
        </li>
      </ol>

      <div class="doc-sep" />

      <h2>1. Define Your Translations</h2>
      <p>
        Keep translation files as plain JSON or TypeScript objects. A simple
        flat-key structure works well:
      </p>
      <CodeBlock
        filename="src/i18n/en.ts"
        code={`export default {
  "home.title": "Welcome to My App",
  "home.subtitle": "Built with viact",
  "nav.home": "Home",
  "nav.about": "About",
  "nav.pricing": "Pricing",
} as const;`}
      />
      <CodeBlock
        filename="src/i18n/fr.ts"
        code={`export default {
  "home.title": "Bienvenue sur Mon App",
  "home.subtitle": "Construit avec viact",
  "nav.home": "Accueil",
  "nav.about": "\u00C0 propos",
  "nav.pricing": "Tarifs",
} as const;`}
      />
      <CodeBlock
        filename="src/i18n/index.ts"
        code={`import en from "./en";
import fr from "./fr";

export const translations: Record<string, Record<string, string>> = { en, fr };
export const defaultLocale = "en";
export const supportedLocales = Object.keys(translations);

export function t(locale: string, key: string): string {
  return translations[locale]?.[key] ?? translations[defaultLocale]?.[key] ?? key;
}`}
      />

      <div class="doc-sep" />

      <h2>2. Locale Detection Middleware</h2>
      <p>
        Create middleware that detects the locale and makes it available to
        loaders. You can detect from a URL prefix, a cookie, or the{" "}
        <code>Accept-Language</code> header.
      </p>

      <h3>URL-prefix strategy</h3>
      <p>
        The cleanest approach for SEO — each locale has its own URL namespace
        like <code>/fr/about</code> or <code>/en/about</code>.
      </p>
      <CodeBlock
        filename="src/middleware/i18n.ts"
        code={`import type { MiddlewareFn } from "viact";
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
  return { redirect: \`/\${locale}\${url.pathname}\` };
};`}
      />

      <h3>Cookie-based strategy</h3>
      <p>
        If you prefer clean URLs without a locale prefix, store the preference
        in a cookie:
      </p>
      <CodeBlock
        filename="src/middleware/i18n.ts"
        code={`import type { MiddlewareFn } from "viact";
import { supportedLocales, defaultLocale } from "../i18n";

export const middleware: MiddlewareFn = async ({ request }) => {
  const cookies = request.headers.get("cookie") ?? "";
  const match = cookies.match(/locale=(\\w+)/);
  const locale = match && supportedLocales.includes(match[1])
    ? match[1]
    : defaultLocale;

  request.headers.set("x-locale", locale);
};`}
      />

      <div class="doc-sep" />

      <h2>3. Load Translations in Your Loader</h2>
      <p>
        Read the locale set by middleware and return the translated content:
      </p>
      <CodeBlock
        filename="src/routes/home.tsx"
        code={`import type { LoaderArgs, RouteComponentProps } from "viact";
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
}`}
      />

      <div class="doc-sep" />

      <h2>4. Wire Routes with Locale Prefix</h2>
      <p>
        Use <code>group</code> with <code>pathPrefix</code> to create
        locale-scoped route groups:
      </p>
      <CodeBlock
        filename="src/routes.ts"
        code={`import { defineApp, group, route } from "viact";

const localizedRoutes = [
  route("/", () => import("./routes/home.tsx"), { render: "ssr" }),
  route("/about", () => import("./routes/about.tsx"), { render: "ssg" }),
  route("/pricing", () => import("./routes/pricing.tsx"), { render: "ssg" }),
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
      route("/", () => import("./routes/locale-redirect.tsx"), { render: "ssr" }),
    ]),
  ],
});`}
      />

      <div class="doc-sep" />

      <h2>5. Language Switcher Component</h2>
      <p>
        A simple component that links to the same page in a different locale:
      </p>
      <CodeBlock
        filename="src/components/LanguageSwitcher.tsx"
        code={`import { useLocation } from "viact";
import { supportedLocales } from "../i18n";

const labels: Record<string, string> = { en: "English", fr: "Fran\u00E7ais" };

export function LanguageSwitcher({ currentLocale }: { currentLocale: string }) {
  const { pathname } = useLocation();

  // Replace the locale segment in the current path
  const switchTo = (locale: string) => {
    const withoutLocale = pathname.replace(/^\\/(en|fr)/, "");
    return \`/\${locale}\${withoutLocale || "/"}\`;
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
}`}
      />

      <div class="doc-sep" />

      <h2>Tips</h2>
      <ul>
        <li>
          For <strong>SSG</strong> pages, use <code>prerender()</code> to
          generate a page per locale:
          <CodeBlock
            code={`export async function prerender() {
  return ["/en/about", "/fr/about"];
}`}
          />
        </li>
        <li>
          Set the <code>lang</code> attribute on your shell's root element so
          browsers and screen readers know the language.
        </li>
        <li>
          For large apps, lazy-load translation files in your loader instead of
          importing everything upfront.
        </li>
        <li>
          For type-safe keys, use <code>keyof typeof en</code> as your
          translation key type.
        </li>
      </ul>

      <div class="doc-nav">
        <a href="/docs/performance" class="doc-nav-card prev">
          <div class="doc-nav-dir">Previous</div>
          <div class="doc-nav-title">&larr; Performance</div>
        </a>
        <a href="/docs/recipes/auth" class="doc-nav-card next">
          <div class="doc-nav-dir">Next</div>
          <div class="doc-nav-title">Authentication &rarr;</div>
        </a>
      </div>
    </div>
  );
}
