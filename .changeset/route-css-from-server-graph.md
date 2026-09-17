---
"@pracht/cli": patch
"@pracht/vite-plugin": patch
---

Emit and link the CSS of routes that do not fully hydrate. A `hydration: "none"` or `hydration: "islands"` route is absent from the client bundle, so its CSS modules were previously compiled for their class names and never emitted, leaving the page with unstyled markup.
