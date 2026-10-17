---
"@pracht/i18n": patch
---

Locale detection now reads the URL prefix after the deploy base (`/my-project/nl/about` is `nl`), and `Accept-Language: zh-TW` or `zh-HK` now picks a registered `zh-Hant` locale over `zh-Hans`.
