# Loaders and the capability graph

**Status:** Draft — proposed, not accepted. This document asks for a decision on
whether to pursue the direction, and if so which stages.

**Date:** 2026-08-31

**Recommendation:** Close the gap between the two data seams in stages. Stage 1
and Stage 2 are cheap and independently valuable; Stage 3 is the "define once"
payoff and can be deferred or dropped without stranding the earlier work.

---

## The observation

Backbone's most durable idea was not `Model` — it was `Backbone.sync`. Every
piece of data crossing the network in a Backbone app funnelled through one
overridable function, so persistence could be swapped, instrumented, or mocked
wholesale in one place. Backbone was wrong about almost everything else and
right about that.

Pracht has two such seams and they do not know about each other.

**Capabilities** are a genuinely good sync layer. One contract — JSON Schema
input and output, an effect class, named middleware, a server-only `run()` —
projected to direct invocation, an HTTP endpoint, a WebMCP page tool, and a
remote MCP tool, all through one validated pipeline
(`input validation → middleware → run() → output validation`). They carry
policy, they emit audit events, they appear in the app graph, they are typed
end to end, and `pracht eval` can drive them.

**Loaders** are the other seam, and they carry almost none of that. They are
where the overwhelming majority of an app's data actually leaves the server.

## Evidence

The two paths as they exist today:

| | Capability dispatch | Loader / route-state dispatch |
| --- | --- | --- |
| Contract in the graph | `input`, `output`, `description`, `title`, `effect` (`app-graph.ts:62`) | `file`, `loaderFile`, `loaderCache`, `middleware` (`app-graph.ts:37`) — where it lives, never what it returns |
| Agent policy (`observe` / `require`) | Enforced (`runtime-capabilities.ts:772`, `:1489`) | Not enforced anywhere |
| Audit event | Emitted for every dispatch (`CapabilityAuditEvent`, `types.ts:908`) | None emitted |
| Verified agent identity | `context.agent` | `context.agent` — surfaced, but nothing consumes it |
| `llms.txt` entry | Name, description, HTTP path | Bare URL: `- [/pricing](/pricing)` |
| `pracht eval` | Scriptable (`eval-runner.ts` steps require `capability: string`) | Not reachable |
| Effect class → client cache | Yes; a non-`read` call revalidates route data | N/A |

Two consequences follow that are worth stating plainly.

**The agent surface is blind to reads.** `defineApp({ agents })`, the audit
sink, `audit-agent-surface`, and the `agentPolicy: "require"` gate all describe
capability traffic. An agent that sends `x-pracht-route-state-request: 1`
(`runtime-constants.ts:28`) with a page URL gets that route's loader data as
JSON, and nothing in the trust layer sees it. For most apps that is not a
vulnerability — the same data is in the SSR'd HTML — but it does mean the
question "what are agents reading from my app" is unanswerable even for an app
that has fully adopted the trust layer, and that a route which *should* demand a
verified agent has no way to say so.

**`llms.txt` claims to describe the app graph and describes half of it.** The
Pages section is a list of URLs. The Capabilities section is a list of typed
contracts. An agent reading the file learns what it can *call* and only what it
can *visit*.

## What is not wrong

Worth stating, because the fix has to preserve it:

- Loaders are ergonomic precisely because they are not contracts. `export function loader({ params, request })` returning a plain object is the right default, and forcing a JSON Schema on every route would be a serious regression.
- Loader data is already constrained to the JSON data model, which is the same restriction capability inputs and outputs carry. The two are compatible.
- Server-owned navigation (the client fetches route state rather than running loaders in the browser) is a good decision and this proposal does not touch it.
- Capabilities being opt-in and private by default is the right posture. Nothing here should make a route's data automatically agent-exposed.

## Options considered

**A. Loaders *are* capabilities.** Desugar every `export function loader()` into
a `read` capability at build time. Maximal unification, and wrong: loaders take
`params` and a `Request`, not a JSON input object; most have no output schema
and should not need one; and output validation on every SSR render is a cost on
the hottest path in the framework. Rejected.

**B. Routes delegate their loader to a capability.** `route("/notes",
"./routes/notes.tsx", { loader: capability("notes.list") })`. Fully additive, no
migration, and gives the "define once" story for the routes that want it — but
on its own it fixes nothing for the thousands of routes that keep an inline
loader.

**C. Unify the description, not the pipeline.** Routes gain an optional
contract in the manifest; the graph, `llms.txt`, agent policy, and the audit
sink learn about reads. Cheap and broad, but stops short of one definition.

The recommendation is **C then B, staged**, with A explicitly rejected.

---

## Stage 1 — describe reads in the graph

Routes gain an optional contract:

```ts
route("/pricing", "./routes/pricing.tsx", {
  render: "isg",
  contract: {
    description: "Current plan tiers, prices, and feature comparison.",
    output: pricingSchema, // optional
  },
});
```

- `AppGraphRoute` gains `description`, `output`, and `agentPolicy`.
- `llms.txt` Pages entries carry the description, so the file finally describes one graph.
- `pracht inspect` and `/_pracht` show reads and writes side by side.
- `output`, when present, is checked in development only — never on the production SSR path.

Everything is optional. An app that declares nothing behaves exactly as it does
today. Cost is small and confined to the manifest types, `app-graph.ts`, and the
`llms.txt` emitter.

## Stage 2 — govern reads

Route-state dispatch runs the same two things capability dispatch does:

- **Agent policy.** `contract.agentPolicy: "require"` on a route makes the
  route-state path answer `401` to an unsigned caller, the same way a capability
  does. Default stays `observe`, so nothing changes for anyone who does not ask.
- **Audit event.** Emit a `CapabilityAuditEvent`-shaped record with
  `effect: "read"` and a new `transport: "route-state"` (and `"ssr"` for the
  document render, if the sink wants it). The existing sink, the
  `add-observability` skill, and any dashboard built on it then cover the
  majority of the app's data egress instead of the mutation slice.

The event shape is already the right shape; this is mostly about calling the
emit from a second place and threading the route's declared policy to it.

Open question: whether the SSR document render should emit an event too. It is
the same data leaving the server, but it is also every page view, so the volume
is a different order of magnitude. Probably opt-in.

## Stage 3 — one definition

```ts
route("/notes", "./routes/notes.tsx", {
  loader: capability("notes.list", { input: ({ params, url }) => ({ tag: params.tag }) }),
});
```

The route's loader delegates to a `read` capability. The contract is authored
once and serves the page, the HTTP endpoint, the MCP tool, and `pracht eval`.
This is the payoff, and also where the real design work is:

- **Input mapping.** Route params and search params are strings; capability
  inputs are typed JSON. The mapping function above is explicit on purpose, but
  it is a new concept in the manifest and deserves its own scrutiny.
- **Caching.** `loaderCache` and a capability's own caching are separate today
  and would need one story.
- **Prerendering.** SSG and ISG call loaders at build time with no `Request`;
  capability dispatch assumes one. Resolvable, not free.
- **Middleware.** A route's middleware chain and a capability's are both named
  chains from the manifest. Running both would double-run shared middleware;
  running one would silently skip guards. Needs a decision.

Stage 3 is worth doing only if Stages 1 and 2 land well. It is deliberately last
so the cheap wins are not held hostage to the hard design.

---

## What this is not

- Not a change to loader ergonomics. `export function loader()` returning a
  plain object stays the default and stays untyped-by-contract.
- Not automatic agent exposure. Declaring a route contract describes the route;
  it does not expose anything that an HTTP client could not already fetch.
- Not output validation on the SSR hot path.
- Not a merge of the two runtimes. Stages 1 and 2 add description and
  governance to the existing loader path; only Stage 3 routes dispatch through
  capability machinery, and only when a route opts in.

## Open questions for the decision

1. Is a route contract the right place for `description`, or should it live in
   the existing `head()` export? (Leaning: the manifest, because `llms.txt` and
   `pracht inspect` read the graph, not the modules.)
2. Should Stage 2's audit event reuse `CapabilityAuditEvent` or get a sibling
   type? Reuse keeps one sink; a sibling avoids stretching "capability" to mean
   "route".
3. Does `agentPolicy: "require"` on a *page* route mean the document render is
   also gated, or only the route-state fetch? Gating only the JSON is
   inconsistent; gating the document changes what a page is.
4. Is Stage 3's input mapping better expressed as a capability that accepts the
   route match directly, rather than a mapping function in the manifest?

## Related

- [CAPABILITY_GRAPH.md](CAPABILITY_GRAPH.md) — the product bet and its decision log
- [CAPABILITIES.md](CAPABILITIES.md) — the shipped capability model
- [DATA_LOADING.md](DATA_LOADING.md) — the shipped loader model
- [AGENT_TRUST.md](AGENT_TRUST.md) — Web Bot Auth, policies, audit events
- [LLMS_TXT.md](LLMS_TXT.md) — what the generated index emits today
