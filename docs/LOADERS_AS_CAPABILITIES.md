# Loader metadata and the capability graph

**Status:** Accepted direction — descriptive route metadata only. Authorization,
auditing, output contracts, and capability-backed loaders require separate
decisions and are not proposed here.

**Date:** 2026-09-02

**Recommendation:** Let authors attach an optional description to a route, then
carry that description through the resolved app graph, `pracht inspect`, the
development graph, and generated `llms.txt`. Preserve the loader runtime
unchanged.

---

## The observation

Pracht has two server-side data seams with intentionally different contracts.

**Capabilities** are explicit operations. They declare JSON Schema input and
output, an effect class, named middleware, and a server-only `run()`. Pracht can
project one capability into direct invocation, HTTP, WebMCP, and remote MCP
while preserving one validation and policy pipeline.

**Loaders** prepare a page representation. They receive the matched route,
params, context, a URL, a cancellation signal, and a Web-standard `Request`.
They normally return serializable page data, but may also return or throw a
`Response` to redirect or short-circuit. They may contain `defer()` markers;
Pracht currently resolves those values before writing every response. During
SSG and initial ISG prerendering, the framework supplies a synthetic GET
`Request` for the concrete build URL—it is not a request-less execution mode.

Those differences are useful. Turning every loader into a capability would add
schema and validation requirements to the framework's hottest read path while
failing to model redirects, response headers, or deferred values honestly.

One small gap remains: the route graph says where a loader lives but not what
the page is about. Generated `llms.txt` therefore lists page URLs without the
short descriptions it can provide for capabilities.

## Decision

Add one optional descriptive field to route metadata.

Manifest router:

```ts
route("/pricing", "./routes/pricing.tsx", {
  render: "isg",
  description: "Current plan tiers, prices, and feature comparison.",
});
```

Pages router:

```ts
export const DESCRIPTION = "Current plan tiers, prices, and feature comparison.";
```

The pages-router spelling is part of the same feature, not follow-up parity.
Its static extraction rules should match existing `RENDER_MODE`, `HYDRATION`,
and `REVALIDATE` exports: a literal is recorded deterministically, while invalid
or opaque declarations receive the same diagnostic posture as comparable page
metadata.

The resolved route and both app-graph serializers gain
`description: string | null`. The field feeds:

- `pracht inspect routes` and graph snapshots;
- the development `/_pracht` graph;
- generated `llms.txt` page entries;
- future documentation or agent-discovery projections that consume the graph.

No description is inferred from `head().title`, rendered HTML, or the loader's
return type. The author controls the agent-facing summary, and omitting it
preserves today's output and behavior.

## Why description belongs in route metadata

`head()` can compute a title from loader data and request context. The graph,
static adapters, and `llms.txt` generation need deterministic metadata without
executing application code, so `head()` is the wrong source for this field.

An optional description is also useful without a loader. Static pages,
loaderless SPA routes, and middleware-produced representations belong in the
same page index. Calling the field a loader contract would make those routes an
awkward exception; it is route metadata.

## Explicit non-goals

- No JSON Schema for loader output.
- No development or production output validation.
- No changes to loader arguments, return values, `Response` short-circuits, or
  `defer()`.
- No changes to SSR, SSG, ISG, SPA, route-state, or browser navigation.
- No automatic capability or agent exposure.
- No agent authorization or audit event on page requests.
- No route-to-capability delegation helper.
- No changes to `pracht eval`.

## Authorization is a separate boundary decision

The original draft proposed `agentPolicy: "require"` on the route-state JSON
request. That is not a valid security boundary. Ordinary Pracht client
navigation uses the same route-state transport, so unsigned browser users
would be rejected. Protecting only JSON would also leave the equivalent data
available in an SSR document, while protecting the document would redefine the
page's human access policy rather than merely govern an agent projection.

Any future route authorization design must start from representation
equivalence and apply consistently to document, Markdown, route-state, and
prerendered/static paths. It also needs a model for ordinary signed-in humans
that is distinct from Web Bot Auth. That work deserves its own RFC and threat
model; descriptive metadata neither implies nor blocks it.

## Auditing is a separate observability decision

Capability audit events describe an operation contract and its effect. A page
view can produce HTML, Markdown, route-state JSON, a redirect, or a custom
`Response`, and document traffic has a very different volume profile from tool
calls. Reusing `CapabilityAuditEvent` would stretch its semantics, while adding
a route event has storage, privacy, sampling, and adapter-fast-path questions.

A later observability proposal may use the route description, but this change
does not emit an event or claim that the capability audit sink covers reads.

## Capability-backed loaders are a separate execution decision

Delegating a route to a read capability may still be valuable for individual
apps, but it is not a consequence of descriptive metadata. A viable design has
to specify:

- mapping string route/search params and the loader `Request` to typed JSON;
- what a capability envelope means to a page component;
- whether route and capability middleware both run and how duplicates behave;
- how loader cache, ISG, redirects, headers, custom `Response` values, and
  `defer()` interact;
- parity between manifest and pages routers.

That should be evaluated independently after concrete use cases justify the
extra execution model. There is no staged commitment from this decision to
build it.

## Acceptance criteria for implementation

1. Manifest and pages routers both accept one optional literal description.
2. Resolved routes and both graph serializers preserve it as
   `string | null`.
3. Text and JSON inspection expose it without changing existing fields.
4. `llms.txt` includes it when present and keeps existing output when absent.
5. Static, serverful, and pages-router test fixtures cover parity.
6. Loader execution and request handling diffs remain empty except for reading
   resolved metadata where a consumer needs it.

## Related

- [CAPABILITY_GRAPH.md](CAPABILITY_GRAPH.md) — the capability product bet and decision log
- [CAPABILITIES.md](CAPABILITIES.md) — the shipped capability model
- [DATA_LOADING.md](DATA_LOADING.md) — loader data, responses, defer, and prerender behavior
- [AGENT_TRUST.md](AGENT_TRUST.md) — Web Bot Auth and capability audit semantics
- [LLMS_TXT.md](LLMS_TXT.md) — generated page and capability discovery
