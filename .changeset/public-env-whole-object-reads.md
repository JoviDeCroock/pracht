---
"@pracht/core": patch
"@pracht/vite-plugin": patch
"@pracht/image": patch
"@pracht/cli": patch
---

Stop whole-object `import.meta.env` reads from inlining non-public env values
into client bundles.

Vite only replaces single-key `import.meta.env.KEY` accesses with their value.
Every other read — a bare reference, destructuring, a spread, or bracket
access — is replaced by an object literal holding all exposed variables,
including the `VITE_`-prefixed ones Pracht does not treat as public. Because
that leaves no accessor text behind, the name-based env leak scan could not see
those values in the output.

- `publicEnv` now reads a `PRACHT_PUBLIC_`-only snapshot injected by the pracht
  Vite plugin instead of enumerating `import.meta.env`, so builds inline public
  values only. Dev and non-Vite (plain Node, tests) behaviour is unchanged.
- `@pracht/image` reads `import.meta.env?.MODE` / `?.DEV` directly for its dev
  warnings instead of pulling in the whole env object.
- Env leak detection (`pracht build` and `pracht verify`) now reports
  whole-object `import.meta.env` reads in first-party client code, and also
  matches optional-chained accesses such as `import.meta.env?.VITE_SECRET`,
  which Vite replaces exactly like dot access but the scan previously ignored.
  Allowlist a deliberate whole-object read with
  `pracht({ envSafety: { allow: ["*"] } })`.
