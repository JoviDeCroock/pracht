---
"@pracht/cli": minor
"@pracht/adapter-static": minor
---

A static export's `notFound` page can now use `hydration: "islands"` or `"none"`, so `404.html` no longer loads the client router. Such a page cannot show the requested URL, and `staticAdapter({ fallback })` still requires a fully hydrated not-found page.
