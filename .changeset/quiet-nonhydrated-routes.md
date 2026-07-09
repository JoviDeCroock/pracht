---
"@pracht/vite-plugin": patch
---

Exclude `hydration: "islands"` and `hydration: "none"` route modules from the generated full client runtime entry so server-only code in non-hydrated routes is not emitted into public client assets.
