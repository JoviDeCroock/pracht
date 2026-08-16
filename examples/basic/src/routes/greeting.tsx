import {
  Form,
  useLocation,
  type HeadArgs,
  type LoaderArgs,
  type RouteComponentProps,
} from "@pracht/core";
import { t, type I18nRequestContext } from "@pracht/i18n";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

import { dictionaries, i18n, type AppLocale, type AppMessages } from "../i18n/index.ts";

type Context = I18nRequestContext<AppLocale>;

// The prefix-free strategy: this page keeps one URL for every locale (no
// /en, no /nl), so detection falls to the cookie and then Accept-Language,
// and the switcher writes the cookie instead of navigating. SSR only — the
// middleware stamps `Vary: Cookie, Accept-Language`, which by design makes
// the response uncacheable in shared caches.
export async function loader({ context }: LoaderArgs<Context>) {
  const messages = await dictionaries.load(context.locale);
  return { locale: context.locale, messages };
}

export function head({ data }: HeadArgs<typeof loader, Context>) {
  return {
    lang: data.locale,
    title: t(data.messages, "greeting.title"),
    // Deliberately no hreflang: there is no alternate URL to point at. That
    // is the SEO cost of one URL per page — crawlers index whichever locale
    // their own Accept-Language resolves to.
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  // Set only by the instant client-side switch below; loader data wins again
  // as soon as it changes (the <Form> switch re-runs the loader).
  const [clientMessages, setClientMessages] = useState<AppMessages | null>(null);
  const clientSwitch = useRef(0);
  useLayoutEffect(() => {
    setClientMessages(null);
    return () => {
      // Layout-effect cleanup runs during the loader-data commit, before a
      // pending import can resume in a microtask and write a stale cookie. It
      // also invalidates pending work synchronously on unmount.
      clientSwitch.current += 1;
    };
  }, [data.messages]);

  const messages = clientMessages ?? data.messages;
  const locale = messages.$locale as AppLocale;
  const title = t(messages, "greeting.title");
  const otherLocales = i18n.locales.filter((candidate) => candidate !== locale);
  const { pathname, search } = useLocation();

  // `head()` runs on the server only, so any locale change that does not
  // reload the document has to keep <html lang> and <title> in sync itself.
  // This covers both switches below.
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = title;
  }, [locale, title]);

  async function switchOnTheClient(next: AppLocale) {
    const switchId = ++clientSwitch.current;
    try {
      const nextMessages = await dictionaries.load(next);
      // Lazy chunks can resolve out of order. Commit only the latest successful
      // choice so the displayed dictionary and persisted cookie stay aligned.
      if (switchId !== clientSwitch.current) return;
      i18n.setLocaleCookie(next);
      setClientMessages(nextMessages);
    } catch (error: unknown) {
      if (switchId === clientSwitch.current) {
        console.error(`[pracht example] Failed to load the ${next} dictionary.`, error);
      }
    }
  }

  return (
    <section>
      <h1 data-testid="greeting-title">{title}</h1>
      <p>{t(messages, "greeting.lead", { language: t(messages, `language.${locale}`) })}</p>
      <p>{t(messages, "greeting.detection")}</p>

      {/*
        Server switch: works with JavaScript disabled — a native POST to the
        API route that sets the cookie and 303s back to this same URL.
      */}
      <Form method="post" action="/api/locale" aria-label="Language switcher">
        <input type="hidden" name="next" value={`${pathname}${search}`} />
        <span>{t(messages, "greeting.switch.server")}</span>{" "}
        {otherLocales.map((candidate) => (
          <button
            key={candidate}
            type="submit"
            name="locale"
            value={candidate}
            data-testid={`greeting-switch-server-${candidate}`}
          >
            {t(messages, `language.${candidate}`)}
          </button>
        ))}
      </Form>

      {/* Client switch: cookie write + lazy dictionary import, no request. */}
      <p>
        <span>{t(messages, "greeting.switch.client")}</span>{" "}
        {otherLocales.map((candidate) => (
          <button
            key={candidate}
            type="button"
            data-testid={`greeting-switch-client-${candidate}`}
            onClick={() => {
              void switchOnTheClient(candidate);
            }}
          >
            {t(messages, `language.${candidate}`)}
          </button>
        ))}
      </p>
    </section>
  );
}
