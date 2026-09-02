---
"@pracht/vite-plugin": minor
"@pracht/cli": minor
"@pracht/core": patch
"@pracht/capabilities": patch
"create-pracht": patch
---

The pages router now supports a root-level `src/pages/_middleware.ts`, registered as the named middleware `pages` and applied to every page route (API routes are not wrapped); scaffold it with `pracht generate middleware --name _middleware`. Underscore-prefixed directories are now reserved for helpers instead of routed, `_app` is recognized only at the pages root, and nested or duplicate `_middleware`, unsupported extensions, and a missing `middleware` export fail the build, `doctor`, and `verify`. Prerendering now fails the build when an `ssg`/`isg` route renders a 5xx rather than warning and skipping it.
