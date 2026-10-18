---
"create-pracht": minor
---

New apps no longer enable `llmsTxt` in `vite.config.ts` or seed the `add-capabilities` skill. Add `llmsTxt: {}` to `pracht()` or run `pracht skills add add-capabilities` when an app needs them.
