---
"@pracht/core": minor
---

Add API-level type safety with Standard Schema validators (#219):

- `defineApi()` wraps API route handlers with [Standard Schema](https://standardschema.dev) validation for `body`, `query`, and `params` (zod, valibot, arktype, …). Invalid requests answer with a standardized 422 JSON body (`{ error: "validation", issues }`, 400 for unparseable bodies) before the handler runs. Handlers can return plain JSON-serializable values (sent as `Response.json()`) or a `Response` for full control.
- `apiFetch()` is a typed fetch client for API routes. With `pracht typegen`, it checks paths, methods, params, bodies, and queries at compile time and returns the handler's response type; without generated types it stays usable with `unknown` payloads. Non-2xx responses throw `ApiFetchError`, exposing normalized validation `issues` when present.
- `<Form>` accepts `schema` (client-side Standard Schema validation of the form data before submitting) and `onValidationIssues` (fires for client-side rejections and for server 422 validation responses), so one schema module covers both sides.
- New exports: `defineApi`, `apiFetch`, `ApiFetchError`, `apiValidationErrorResponse`, `isApiValidationErrorBody`, `validateStandardSchema`, `formDataToRecord`, `searchParamsToRecord`, and the supporting types (`ApiValidationIssue`, `ApiRouteMethodMap`, `ApiPath`, `ApiFetchOptions`, …). `@standard-schema/spec` (types-only) is now a dependency.
