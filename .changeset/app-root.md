---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
---

Add `defineApp({ root })` (`pages/_root.tsx` in the pages router), an app root that renders above every shell, stays mounted across client navigations, and hands its state from the server to the browser; loaders read it as `args.root`, typed by `pracht typegen`.
