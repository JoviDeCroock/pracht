---
"@pracht/core": minor
---

API validation and typed fetch DX improvements:

- New `json(value, init)` helper: behaves like `Response.json()` but returns a `TypedJsonResponse` whose payload type stays visible to `apiFetch()`, so handlers can use custom status codes and headers without collapsing the client-side response type to `unknown`.
- `apiFetch()` query and params typing now rejects, at compile time, concrete schema keys whose input has no string representation (e.g. `z.number()`): URL values cross the wire as strings, so those schemas could never validate a real request. String-accepting inputs (`z.coerce.number()`, enums, unions with a string arm) pass through unchanged, while route params keep accepting convenient stringifiable primitives at the call site.
- Routes whose body schema contains `File`/`Blob` values now accept `FormData` in their typed `apiFetch()` body — JSON-encoding a `File` would silently drop it.
- `<Form>` gains `onResponse`, called with the server's `Response` for every non-redirect fetch submission (success payloads and non-validation failures alike, with the body left unconsumed); `onValidationIssues` now also fires for the standardized 400 malformed-body response, matching `ApiFetchError`; and `action` autocompletes registered API route paths while still accepting any URL string.
- `<Form>` enhanced submissions honor the clicked button's `formaction` and `formmethod`, matching native multi-action form behavior.
- JSON-safety checks stay active at runtime so JavaScript and other untyped callers cannot return values that silently change shape across the response boundary.
