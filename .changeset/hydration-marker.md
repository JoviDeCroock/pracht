---
"@pracht/core": minor
---

The client router now sets `data-pracht-hydrated="true"` on `<html>` once it
finishes initializing. Server-rendered pages look interactive before
hydration, so end-to-end tests that drive prerendered forms too early trigger
native form submits instead of the framework handlers — wait for
`html[data-pracht-hydrated]` before interacting. Documented in
`docs/ROUTING.md` under "Testing Hydration".
