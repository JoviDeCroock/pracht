---
"@pracht/core": patch
"@pracht/cli": patch
---

Keep capability forms and static verification consistent across framework surfaces:

- **`@pracht/core`**: enhanced `<Form capability>` submissions now honor a clicked submitter's `formaction` and navigate redirects returned by capability middleware, matching the form's no-JavaScript behavior.
- **`@pracht/cli`**: `pracht verify` rejects primitive and array `expose` values instead of reporting a complete exposed contract, and correctly describes an empty exposure object as private.
