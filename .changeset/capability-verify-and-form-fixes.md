---
"@pracht/capabilities": patch
"@pracht/cli": patch
---

Fix two capability issues found in review:

- **`@pracht/cli`**: `pracht verify` now resolves root-relative capability registrations (`() => import("/src/capabilities/x.ts")`) against the project root, matching the runtime registry and the Vite plugin. Previously they resolved against the manifest directory, never existed on disk, and were skipped without a check or a warning — so the destructive-exposure and `PRACHT_CONFIRMATION_SECRET` checks were silently bypassed while verification still reported success. A root-relative reference that really is missing is now reported as an error (the manifest check only covers `./`-relative paths).
- **`@pracht/capabilities`**: `coerceFormInput()` looks up a field's schema with an own-property check and writes coerced values with `Object.defineProperty`, so a form field named `__proto__` or `constructor` can neither pick up an inherited member as its schema nor vanish into the prototype setter. Such fields now reach validation as real own properties and are rejected by `additionalProperties: false` instead of being silently dropped.
