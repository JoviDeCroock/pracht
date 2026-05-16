---
"@pracht/core": patch
---

fix(security): close two defense-in-depth gaps in client-side URL navigation

`navigate()` (exposed as `window.__PRACHT_NAVIGATE__`) was assigning non-same-origin URL strings directly to `window.location.href` without scheme validation. A `javascript:` URL has origin `"null"`, so `resolveBrowserRouteTarget` returned null and the raw string reached the sink. Now gated by `parseSafeNavigationUrl` — unsafe schemes are refused and logged; valid `http:`/`https:` external URLs continue to work.

`Form`'s opaque-redirect fallback (`window.location.href = props.action ?? form.action`) bypassed `navigateToClientLocation` and its scheme guard. Collapsed into a single `navigateToClientLocation(location ?? props.action ?? form.action)` call so the safe-navigation path is always taken, and same-origin targets get SPA navigation instead of a full page reload.
