---
"@pracht/core": patch
---

A request the client abandoned mid-load no longer reaches `onRouteError` or renders an error page; it answers 499 instead, so abandoned navigations stop appearing in error tracking as application faults. A `loaderTimeoutMs` expiry is still reported.
