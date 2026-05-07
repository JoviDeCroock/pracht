---
"@pracht/core": patch
---

Bump `preact-suspense` to `^0.3.0`. The new version installs its `options.__e` hook lazily in the `Suspense` constructor (instead of at module load), which would otherwise let preact-suspense's catch-error wrapper sit in front of pracht's hydration suspension counter and short-circuit on Suspense ancestors before our counter could see them. Eagerly construct one throwaway `Suspense` instance during `hydration.ts` module init so preact-suspense's hook is in place before pracht wraps it.
