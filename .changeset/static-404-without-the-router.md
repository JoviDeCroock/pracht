---
"@pracht/cli": minor
"@pracht/adapter-static": minor
---

A static export's `notFound` page can now use `hydration: "islands"` or `"none"`, keeping the client router out of `404.html` — on an otherwise islands-only site that is the largest chunk in the build, requested by that one page. The page then shows the markup it was prerendered with, so it cannot report the requested URL; `staticAdapter({ fallback })` still requires full hydration because that document is built from the not-found page's route state.
