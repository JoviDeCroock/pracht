import type { HeadArgs, LoaderArgs, RouteComponentProps } from "@pracht/core";
import { t, tPlural, type I18nRequestContext } from "@pracht/i18n";
import { useEffect } from "preact/hooks";

import { dictionaries, i18n, type AppLocale } from "../i18n/index.ts";

// `context.locale` is set by the i18n middleware. This example types it
// per-file to keep the monorepo-wide `Register` clean; an app would
// normally register it once instead:
//
//   declare module "@pracht/core" {
//     interface Register {
//       context: I18nRequestContext<"en" | "nl">;
//     }
//   }
type Context = I18nRequestContext<AppLocale>;

export async function loader({ context }: LoaderArgs<Context>) {
  // The loaded dictionary is a plain serializable object, so it can be
  // returned as route data and consumed with the same `t()` on the client.
  const messages = await dictionaries.load(context.locale);
  return { locale: context.locale, messages, noteCounts: [0, 1, 5] };
}

export function head({ data, url }: HeadArgs<typeof loader, Context>) {
  return {
    lang: data.locale,
    title: t(data.messages, "welcome.title"),
    // Alternate links for every registered locale plus x-default, pointing
    // at the unprefixed detector route. Use your canonical origin in
    // production instead of the request origin.
    link: i18n.hreflang(url.pathname, { origin: url.origin }),
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  const { locale, messages } = data;
  const otherLocales = i18n.locales.filter((candidate) => candidate !== locale);

  // These locale-prefixed pages are prerendered, so their stored response
  // cannot carry a visitor-specific Set-Cookie header. Remember the explicit
  // prefix after hydration so the SSR /welcome detector can honor it later.
  // The same effect is safe on SSR pages (where the middleware already wrote
  // the matching cookie).
  useEffect(() => {
    i18n.setLocaleCookie(locale);
  }, [locale]);

  return (
    <section>
      <h1>{t(messages, "welcome.title")}</h1>
      <p>{t(messages, "welcome.lead", { language: t(messages, `language.${locale}`) })}</p>
      <p>{t(messages, "welcome.detection")}</p>
      <ul>
        {data.noteCounts.map((count) => (
          <li key={count}>{tPlural(messages, "welcome.notes", count)}</li>
        ))}
      </ul>
      <nav aria-label="Language switcher">
        {t(messages, "welcome.switch")}{" "}
        {otherLocales.map((candidate) => (
          <a key={candidate} href={i18n.localePath("/welcome", candidate)}>
            {t(messages, `language.${candidate}`)}
          </a>
        ))}
      </nav>
    </section>
  );
}
