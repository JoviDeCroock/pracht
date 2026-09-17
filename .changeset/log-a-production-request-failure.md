---
"@pracht/core": patch
---

Log a request failure server-side when nothing else reports it, so a deployed app no longer answers 500 with an empty log. A loader, render, or API handler failure prints the same line `pracht dev` prints — phase, route, source file, path, message — plus the stack; an expected 404 stays quiet, and a host that passes `onRouteError`/`onApiError` still owns the reporting.
