---
"@pracht/core": patch
---

A `<Form capability>` posting to a cross-origin endpoint no longer reports a `useNavigation()` submitting state, which briefly re-enabled buttons gated on it while the browser was already navigating away.
