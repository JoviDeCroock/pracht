---
"@pracht/vite-plugin": patch
---

Keep the CSS of islands, and of anything a route shares with one, out of the server entry's merged stylesheet, so a route that does not fully hydrate links exactly the stylesheets it renders — served from the copy the client build already published.
