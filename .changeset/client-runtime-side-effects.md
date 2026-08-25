---
"@pracht/core": patch
"@pracht/vite-plugin": patch
---

Drop Suspense and capability code from client bundles that do not use them.

Two features were reachable from `@pracht/core/client` — the entry every
hydrating route loads — even when an app used neither, because they were wired
through module-level side effects rather than through the code that needs them.

- The hydration suspension counter, which needs `preact-suspense`, moved out of
  `hydration.ts` into `hydration-suspense.ts`. It is installed by a
  `/* @__PURE__ */` wrapper on the `Suspense` and `lazy` exports, so an app that
  renders no boundary drops the counter and `preact-suspense` with it.
- Capability revalidation moved out of `PrachtRuntimeProvider` into
  `runtime-capability-revalidate.ts`, installed by the two paths that can
  dispatch `CAPABILITY_SETTLED_EVENT`: `<Form capability>` and the generated
  `callCapability()`. Apps with no capabilities no longer pull
  `@pracht/capabilities` or the revalidation runtime into the client bundle.

No API or behaviour change: `onHydrationComplete()` still waits for suspended
boundaries, and a settled non-`read` capability call still refreshes route data.
A production build of the router runtime drops from 9,917 to 9,410 gzip
bytes; `package-tree-shaking.test.ts` now holds a ceiling on it.
