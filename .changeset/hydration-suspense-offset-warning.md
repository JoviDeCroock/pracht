---
"@pracht/core": patch
---

Warn in dev when a Suspense boundary resolves during hydration and the
resolved component renders 0 or >1 top-level DOM nodes. Such returns cause
sibling offset drift in preact-suspense's in-place hydration swap (see
preact issue #4442). The warning is appended to the existing hydration
mismatch banner and is stripped from production builds.
