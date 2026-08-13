---
"@pracht/i18n": patch
---

Align dictionary key types with runtime sanitization, and preserve special own
flat keys such as `__proto__` without invoking object prototype behavior.

Document and test how prerendered locale-prefixed pages remember an explicit
locale after hydration without placing a visitor-specific `Set-Cookie` header
in shared SSG/ISG output.
