import { createDictionaries, defineI18n } from "@pracht/i18n";

// One i18n instance per app: the locale registry, detection middleware
// (re-exported from src/middleware/i18n.ts for the manifest), and the
// localePath/hreflang helpers.
export const i18n = defineI18n({
  locales: ["en", "nl"],
  defaultLocale: "en",
  // Detection order (also the default): explicit URL prefix beats the
  // remembered cookie beats the browser's Accept-Language header. This order
  // serves both strategies dogfooded here — the prefix wins on /en/welcome
  // and /nl/welcome, and simply never matches on the prefix-free /greeting,
  // where the cookie decides.
  detect: ["path", "cookie", "header"],
});

export type AppLocale = (typeof i18n.locales)[number];

// Lazily loaded per locale on the server. Typed keys come from the default
// locale's dictionary shape; other locales merge over it so missing keys
// fall back to English at load time.
export const dictionaries = createDictionaries(
  {
    en: () => import("./locales/en.ts"),
    nl: () => import("./locales/nl.ts"),
  },
  { defaultLocale: "en" },
);

/** A loaded dictionary — handy when client code holds one in state. */
export type AppMessages = Awaited<ReturnType<typeof dictionaries.load>>;
