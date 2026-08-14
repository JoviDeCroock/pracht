---
"@pracht/i18n": patch
---

Preserve explicit `q=0` exclusions throughout fallback matching, prefer
registered locale variants directly matched by an `Accept-Language` range, and
keep query/hash suffixes on the default `x-default` hreflang target.

Harden the documented prefix-free client switch so only the latest
successfully loaded dictionary updates the locale cookie and rendered state.
