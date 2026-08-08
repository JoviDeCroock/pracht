---
"@pracht/openapi": minor
"@pracht/cli": minor
"@pracht/vite-plugin": minor
---

Add an opt-in OpenAPI 3.1 companion plugin with live JSON and optional
Scalar/Swagger UI endpoints, matching static build artifacts for every adapter,
typed operation descriptors, Standard JSON Schema conversion, and configurable
completeness warnings. Generated endpoint paths are canonicalized and checked
for static output collisions, and request-body requiredness matches runtime
schema validation. Compatible CLI and Vite plugin versions are enforced through
peer dependencies, catch-all parameter schemas retain their constraints, and
bodyless HTTP methods no longer advertise unreachable request bodies.
