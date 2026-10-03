---
"@pracht/core": patch
---

A deployed app now logs loader, render, and API handler failures with their phase, route, source file, path, message, and stack instead of answering 500 with an empty log. Expected 404s stay quiet, and a host that passes `onRouteError`/`onApiError` still owns the reporting.
