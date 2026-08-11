---
"@pracht/adapter-cloudflare": patch
"@pracht/cli": patch
"@pracht/core": minor
"@pracht/vite-plugin": minor
---

Keep read-only app-graph commands independent from deployment runtimes and shared Vite
optimizer state. Cloudflare inspection now exits cleanly, concurrent graph readers use
isolated caches, and graph-loaded contracts retain safe stubs for Cloudflare runtime
imports, including the current `cloudflare:workers` entrypoint classes, environment,
execution helpers, cache, and tracing shapes. Environment and service-binding placeholders
remain safe to import or retain, and runtime classes remain safe to import or subclass.
Binding property reads, construction, mutation, membership checks, reflection, and
enumeration fail loudly instead of imitating an empty binding environment or runtime.
Cloudflare allows top-level binding reads, but graph-loaded API and capability modules
must defer them into handlers, `run()`, or another request-time function so placeholder
truthiness, `typeof`, or strict equality cannot silently corrupt graph metadata. The
development banner resolves methods
exposed through API module re-exports without executing every API module at startup,
following Vite's alias and TypeScript resolution semantics while keeping source reads
inside the application root. Static graph scans only report default API handlers when
local syntax establishes a callable value and ignore export-like text inside regular
expressions. Live inspect, plan, type generation, and verification now fail closed with
the original module error when a registered capability cannot load instead of silently
emitting null security and transport metadata. Live API graph consumers likewise retain
the route, file, and original initialization error instead of silently inferring methods
from source after a failed import; API type generation remains intentionally non-executing.
TypeScript declaration files under `apiDir` are excluded consistently from generated
registries, dependency scanning, runtime route normalization, CLI discovery, graph
inspection, verification, planning, and type generation rather than appearing as bogus
`/api/*.d` endpoints.

The public graph API now exposes `detectApiExportsStatic()` and
`serializeApiRoutesStatic()` for side-effect-free consumers, together with
`AppGraphStaticModuleAccess` and strict options for `serializeApiRoutes()` and
`serializeCapabilities()`.

Custom adapters can now provide `graphVitePlugins()` separately from their deployment
`vitePlugins()`. Pracht loads only that explicitly graph-safe hook for inspect, plan,
verify, report, doctor, and type-generation servers, preventing deployment runtimes from
starting while still allowing adapters to resolve platform-only contract imports.
