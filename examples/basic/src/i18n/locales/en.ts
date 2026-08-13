export default {
  "welcome.title": "Welcome to pracht",
  "welcome.lead": "This page is served in {language} via @pracht/i18n.",
  "welcome.detection":
    "The locale came from the URL prefix; unprefixed /welcome redirects using cookie and Accept-Language detection.",
  "welcome.notes.one": "You have {count} note.",
  "welcome.notes.other": "You have {count} notes.",
  "welcome.switch": "Read this page in",
  "greeting.title": "One URL, every language",
  "greeting.lead": "This page is served in {language} without a locale prefix.",
  "greeting.detection":
    "The URL never changes: the locale comes from the cookie, falling back to Accept-Language.",
  "greeting.switch.server": "Switch with a form post (works without JavaScript):",
  "greeting.switch.client": "Switch on the client (no request at all):",
  "language.en": "English",
  "language.nl": "Dutch",
} as const;
