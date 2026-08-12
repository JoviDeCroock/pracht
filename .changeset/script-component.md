---
"@pracht/core": minor
---

Add a first-party `<Script>` component with loading strategies — the framework's next/script analogue for third-party scripts.

- `strategy="beforeHydration"` collects the script during the server render and emits it into the document `<head>` alongside `head()` scripts, so it runs before hydration. On client-side navigations (where the head is not re-rendered) the script is injected immediately instead, with a dev warning.
- `strategy="afterHydration"` (default) injects the script once hydration completes.
- `strategy="idle"` injects in `requestIdleCallback` (setTimeout fallback).
- `strategy="visible"` renders a zero-size placeholder and injects the script when it enters the viewport, mirroring the islands `client="visible"` strategy.

Supports `src`, `id`, `async`, `defer`, `type`, `nonce`, `integrity`, `crossorigin`, `referrerpolicy`, client-only `onLoad`/`onError`, and inline string children as an alternative to `src`. Attributes pass through an allowlist (never `on*` handlers), matching the head-rendering safety posture. A script identified by `id`, `src`, or inline content is never injected twice — across re-renders, client navigations, and server-emitted tags. Client strategies on `hydration: "none"` routes warn in dev, since those routes ship no JavaScript.
