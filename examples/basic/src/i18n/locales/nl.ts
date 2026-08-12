export default {
  "welcome.title": "Welkom bij pracht",
  "welcome.lead": "Deze pagina wordt in het {language} geserveerd via @pracht/i18n.",
  "welcome.detection":
    "De taal komt uit het URL-voorvoegsel; /welcome zonder voorvoegsel gebruikt cookie- en Accept-Language-detectie.",
  "welcome.notes.one": "Je hebt {count} notitie.",
  "welcome.notes.other": "Je hebt {count} notities.",
  // "welcome.switch" is deliberately missing: dictionaries.load() merges the
  // default locale underneath, so the English string renders here — the
  // documented missing-key fallback, kept visible on purpose.
  "language.en": "Engels",
  "language.nl": "Nederlands",
} as const;
