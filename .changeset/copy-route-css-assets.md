---
"@pracht/vite-plugin": patch
---

Copy the assets a route stylesheet references — background images, self-hosted fonts, `@import`ed stylesheets — into the client output, so a route outside the client bundle no longer ships CSS pointing at files that were left in `dist/server`.
