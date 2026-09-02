---
"@pracht/core": minor
---

`useRouteData(routeId)` now throws when the id is not the active route instead of returning another route's data under the requested route's type, which previously only produced a development warning.
