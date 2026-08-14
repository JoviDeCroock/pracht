---
"@pracht/i18n": patch
---

Harden locale negotiation at the remaining public edge cases: reject duplicate
quality parameters, keep wildcard fallbacks from reviving `q=0` locales, avoid
same-language best fit across conflicting scripts, and keep every locale
accepted by `defineI18n()` detectable regardless of its configured tag length.
