# Pracht Capability Graph

**Status:** Product direction proposal  
**Date:** 2026-07-10  
**Recommendation:** Make typed, protocol-neutral application capabilities the next major Pracht
primitive.

## The Bet

Pracht should let developers define a domain operation once and deliberately project it into the
surfaces where people and agents work:

- a server-side function used by the web application;
- an HTTP endpoint or progressively enhanced form action;
- a remote Model Context Protocol (MCP) tool;
- a WebMCP tool registered in the page for in-browser agents;
- an optional interactive Preact view rendered inside MCP Apps hosts.

The result is not an AI SDK and not an automatically generated chatbot. It is a **capability
compiler**: one explicit, typed contract for an application action, with adapters for humans,
programs, and agents.

```text
                         ┌─ browser route / <Form>
                         ├─ HTTP endpoint
schema + policy + run ───┼─ remote MCP tool (structured result)
                         ├─ WebMCP tool (in-browser agents)
                         └─ MCP App (Preact UI)
```

This moves Pracht's AI story from “agents can help build this application” to “the finished
application is natively usable by agents.”

## Why This, Why Now

MCP has moved beyond local developer tools. Its standard HTTP transport is Streamable HTTP, its
HTTP authorization model is based on OAuth, and production platforms now document both stateless
and stateful remote MCP deployments. Three 2026 developments make the timing concrete rather than
speculative:

- **MCP Apps became the first official MCP extension (January 2026)**, with host support in
  ChatGPT, Claude, Goose, and VS Code — and the official `ext-apps` starter templates include
  Preact as a first-class choice. Preact's bundle size is a genuine advantage inside sandboxed
  iframe resources.
- **The MCP 2026-07-28 release makes the core protocol stateless.** No session handshake means
  remote MCP finally matches how Pracht's Cloudflare and Vercel adapters already want to run:
  ordinary stateless request handling at the edge.
- **WebMCP entered Chrome origin trial (Chrome 149, June 2026).** Authored by Google and
  Microsoft in the W3C Web ML CG, it lets a web page register typed tools for in-browser agents —
  the page itself becomes the tool surface. No framework has integrated it yet.

Relevant primary references:

- [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP 2026-07-28 release candidate (stateless core, Apps + Tasks extensions)](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview)
- [MCP Apps specification (SEP-1865)](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp)
- [WebMCP origin trial announcement](https://developer.chrome.com/blog/ai-webmcp-origin-trial)
- [Cloudflare remote MCP deployment guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)
- [Web Bot Auth / signed agents](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/)

Pracht already has nearly every compiler input this needs:

- an explicit application manifest and resolved graph;
- named middleware and adapter-provided request context;
- API dispatch based on Web `Request` and `Response`;
- Preact client, SSR, and islands build environments;
- structured inspection, verification, and MCP tooling;
- Markdown content negotiation for agent-readable pages;
- Node, Cloudflare, and Vercel deployment adapters.

The missing layer is the application's **domain graph**: which operations exist, what input and
output they accept, who may run them, what side effects they have, and which user interface can
represent their result.

Pracht is unusually well positioned to add that layer without hiding it in filesystem or compiler
magic. A developer should be able to open one manifest and audit both the page graph and the
capability graph.

## Candidate Comparison

Scores are 1–10. “Leverage” asks how much new product surface the feature unlocks; “fit” asks how
well it composes with Pracht's current architecture; “defensibility” asks whether it can become a
reason to choose Pracht rather than a parity checkbox. The total weights leverage at 30%, fit at
25%, defensibility at 20%, time to a convincing proof at 15%, and delivery confidence at 10%.
Higher is better for every column.

| Candidate | Leverage | Fit | Defensibility | Proof speed | Delivery confidence | Weighted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Capability graph + agent surfaces | 10 | 9 | 9 | 7 | 6 | **8.70** |
| Streaming SSR + deferred loaders | 8 | 8 | 5 | 5 | 5 | 6.65 |
| More coding-agent diagnostics/autofix | 7 | 9 | 5 | 8 | 8 | 7.35 |
| First-party model/generative-UI SDK | 8 | 6 | 4 | 6 | 5 | 6.10 |
| Client navigation for islands routes | 6 | 8 | 5 | 6 | 6 | 6.30 |

Streaming SSR remains important and is already tracked in
[#191](https://github.com/JoviDeCroock/pracht/issues/191), but it is framework parity rather than a
new category. More developer MCP tools improve the build loop, but
[Next.js now documents a similar coding-agent MCP surface](https://nextjs.org/docs/app/guides/mcp).
A model SDK would enter a crowded, fast-changing abstraction layer and
would couple Pracht to provider APIs. The capability graph instead builds on stable web primitives
and keeps MCP behind an adapter boundary.

## Landscape Validation (July 2026)

A survey of what frameworks and the agent ecosystem actually ship confirms the gap this proposal
targets, and sharpens where the moat is.

**Every incumbent's agent story is dev-time, not runtime.** Next.js publicly framed its agent
strategy around coding agents — devtools MCP, `agents.md`, skills — after sunsetting its in-browser
agent experiment ([Building Next.js for an agentic future](https://nextjs.org/blog/agentic-future),
February 2026). Astro's acquisition by Cloudflare (January 2026) signals that infrastructure
companies consider frameworks strategic for the agentic web, but no framework's flagship story is
making the *deployed application* usable by end-user agents.

**"Define once, project everywhere" does not exist yet.** Laravel MCP and Rails ActionMCP define
tools as a second surface, separate from routes, controllers, and forms. Nuxt's `mcp-toolkit` has
the closest framework-native DX but is again a parallel definition. tRPC-MCP bridges existing
procedures but has no forms or UI projection and no policy layer. WebMCP's annotated forms are the
only shipping artifact where one definition doubles as an agent tool — browser-side only. Nobody
ships the full projection this document proposes.

**The loudest developer pain is trust, not plumbing.** Audits of the remote MCP ecosystem find
roughly 40% of servers require no authentication at all, widespread plaintext credential handling,
and overscoped tokens that defeat per-tool policy
([Scalekit](https://www.scalekit.com/blog/mcp-authentication-authorization-build-vs-buy-roadmap),
[Lenses.io](https://lenses.io/blog/mcp-server-production-security-challenges)). Meanwhile
auto-generated tool sprawl ("GitHub MCP dumps 43 tools into the context window") demonstrably hurts
agent task completion. This validates two of this proposal's core choices: explicit curated
registration and effect classes with policy. Schema-to-tool conversion is a commodity; **the
security model is the product.**

**Distribution through agent hosts is unproven — treat MCP Apps as a projection, not a growth
channel.** OpenAI's app directory reached ~300 integrations by March 2026 with reportedly little
traffic to partners. Ship the Preact Apps projection because it is cheap once the graph exists,
not as an acquisition strategy.

**Adjacent signals worth absorbing cheaply, not betting on:**

- `llms.txt` is broadly published and almost never read (an Ahrefs study of 137k sites found 97%
  of the files received zero bot requests). Emitting one from the resolved route/capability graph
  is an afternoon of work and a Lighthouse "Agentic Browsing" checkbox — do it, don't market it.
- Web Bot Auth (RFC 9421 signed agents) now covers the large majority of identified AI-browser
  traffic and is implemented by major CDNs. Verifying agent identity belongs in Pracht's adapter
  request pipeline and folds directly into the principal contract below.
- Agent payments (x402, AP2) are real but crypto-native today; effect classes should leave room
  for a future `payment-required` policy rather than integrating now.

## Product Promise

> Build the product once. Let people use it on the web and let their agents use the same product
> safely, with the same business rules and an optional Preact interface.

A project-management application, for example, could expose `projects.search`, `projects.create`,
and `projects.archive`. The browser uses those operations for its normal routes and forms. An agent
can call them as typed tools. When a table, diff, confirmation form, or chart communicates the result
better than text, the same deployment can provide a small Preact view to a host that supports MCP
Apps. Hosts without UI support still receive useful structured and text results.

The progressive enhancement order is important:

1. typed server operation;
2. structured tool result;
3. web UI;
4. embedded agent UI.

No capability should require a model or an MCP Apps-capable host to remain useful.

## Proposed Developer Model

### Explicit manifest registration

Capabilities should be named and registered like shells and middleware:

```ts
// src/routes.ts
import { defineApp } from "@pracht/core";

export const app = defineApp({
  capabilities: {
    "projects.search": () => import("./capabilities/projects-search.ts"),
    "projects.create": () => import("./capabilities/projects-create.ts"),
    "projects.archive": () => import("./capabilities/projects-archive.ts"),
  },
  // shells, middleware, routes...
});
```

This is deliberately opt-in. Pracht must not turn every loader or API handler into a public agent
tool. Existing HTTP endpoints often have ambiguous schemas, browser-cookie assumptions, or effects
that are unsafe to expose to autonomous callers.

### A protocol-neutral capability

The exact schema API needs a spike. The important contract is shown below; this is illustrative,
not a frozen API:

```ts
// src/capabilities/projects-search.ts
import { defineCapability, jsonSchema } from "@pracht/capabilities";

export default defineCapability({
  title: "Search projects",
  description: "Find projects visible to the current account.",
  input: jsonSchema({
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    },
    required: ["query"],
    additionalProperties: false,
  }),
  output: jsonSchema({
    type: "object",
    properties: {
      projects: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            status: { type: "string" },
          },
          required: ["id", "name", "status"],
        },
      },
    },
    required: ["projects"],
  }),
  effect: "read",
  middleware: ["auth"],
  expose: {
    http: { method: "POST", path: "/api/capabilities/projects/search" },
    mcp: true,
    webmcp: true,
  },
  ui: () => import("../agent-ui/project-results.tsx"),
  async run({ input, context, principal, signal }) {
    return {
      projects: await context.db.projects.search({
        accountId: principal.accountId,
        query: input.query,
        limit: input.limit,
        signal,
      }),
    };
  },
});
```

The capability handler should receive an authenticated `principal`, not ask every operation to
re-parse a transport credential. Transport authentication establishes identity; named middleware
and the handler still enforce application authorization.

### Browser use

Browser code should be able to invoke the same capability through generated, typed helpers:

```tsx
import { capability } from "virtual:pracht/capabilities";

const searchProjects = capability("projects.search");

export function SearchForm() {
  return (
    <searchProjects.Form>
      <input name="query" required />
      <button type="submit">Search</button>
    </searchProjects.Form>
  );
}
```

This example is also exploratory. A less magical `useCapability()` plus `<Form action>` may fit
Pracht better. The invariant is that browser use, HTTP dispatch, MCP dispatch, and direct server use
all call the same validated handler rather than reimplementing business logic.

### Agent use

A build with agent exposure enabled serves Streamable HTTP at a configured endpoint, conventionally
`/mcp`. `tools/list` is generated from the resolved capability graph. `tools/call` performs:

```text
transport validation
  → transport authentication
  → capability lookup
  → input validation
  → named middleware
  → capability authorization/policy
  → run()
  → output validation
  → structured result (+ text fallback)
```

If `ui` is present and the host negotiated MCP Apps support, the tool metadata references a
build-generated `ui://` resource. Pracht bundles that Preact entry as a sandbox-compatible HTML
resource. The view receives the validated tool input and result through the MCP Apps bridge and can
call only explicitly allowed capabilities.

### In-browser agent use (WebMCP)

WebMCP inverts the deployment model: instead of an agent connecting to a remote server, the page
registers typed tools that an in-browser agent (Gemini in Chrome today; origin trial through
Chrome 156) can call while the user watches. For a *web* framework this may be the larger prize —
it is the only emerging standard where the website itself is the tool surface, and no framework
integrates it yet.

With `expose.webmcp` enabled, the client runtime registers the capability as a page tool on routes
that declare it, reusing the same JSON Schema for parameters. The browser-side tool implementation
is thin: it calls the generated HTTP endpoint, so validation, middleware, policy, and `run()` all
stay server-side. The user's existing session authenticates the call — which is correct for
WebMCP's model (the agent acts *as the signed-in user, in their tab*) and exactly wrong for remote
MCP (see the security model: browser cookies must never authenticate the remote transport). Effect
classes still gate what an in-page agent may do: `destructive` capabilities keep their
server-verified confirmation flow regardless of who clicks.

The marginal cost on top of the capability graph is small — a client registration shim and typegen —
and it makes Pracht the first framework where one definition serves human forms, remote agents, and
in-browser agents. If WebMCP fails to graduate from its origin trial the shim is deleted without
touching the core contract; that is the point of protocol-neutral capabilities.

## The Capability Graph

The Vite plugin should compile manifest registrations and module metadata into a graph that can be
inspected without executing operations:

```json
{
  "capabilities": [
    {
      "name": "projects.search",
      "title": "Search projects",
      "effect": "read",
      "middleware": ["auth"],
      "transports": ["http", "mcp"],
      "hasUi": true,
      "source": "/src/capabilities/projects-search.ts"
    }
  ]
}
```

That graph becomes a source of truth for:

- `pracht inspect capabilities --json`;
- a new section in `/_pracht`;
- `pracht verify` policy and schema checks;
- `pracht generate capability`;
- route-to-capability dependency and performance analysis;
- generated TypeScript helpers;
- MCP tool/resource registration;
- deployment warnings when an adapter cannot provide a requested feature.

Unlike a protocol-first MCP module, this graph remains valuable if a different agent protocol wins
later. MCP is the first projection, not the core abstraction.

## Architecture

### Package boundary

The recommended first implementation is an optional `@pracht/capabilities` package rather than
adding the MCP SDK to `@pracht/core`:

```text
@pracht/core
  manifest hooks + shared request context types

@pracht/capabilities
  defineCapability + validation + execution + generated client helpers

@pracht/vite-plugin
  discovery/code generation + separate agent UI build entry

@pracht/adapter-*
  Streamable HTTP handoff, origin/body-limit integration

@pracht/cli
  inspect/verify/generate + local protocol inspector hints
```

The MCP SDK and MCP Apps bridge stay optional and out of normal client bundles. Applications that
do not register capabilities pay no runtime or build cost.

### Schema boundary

MCP tool schemas use JSON Schema, and the capability graph also needs serializable build metadata.
The MVP should therefore store JSON Schema rather than a runtime-library-specific schema. A helper
can add TypeScript inference, and adapters for libraries that can faithfully emit JSON Schema can
come later. Validation must happen at both input and output boundaries.

The spike should test JSON Schema 2020-12 support and generated type quality before choosing a
validator. Pracht should not require Zod in application client bundles merely because the current
CLI MCP server uses it.

### Build environments

Capability handlers are server-only. Agent UI entries are client-only, separately bundled, and must
not import the handler or server context. This is the same useful separation Pracht already enforces
between route loaders and client-transformed route modules.

MCP App resources need a stricter output contract than normal routes:

- one auditable HTML resource per UI entry;
- explicit, deny-by-default content security policy metadata;
- no dependence on the parent page's cookies, DOM, storage, or global CSS;
- only the MCP Apps bridge as the host communication channel;
- small asset budgets reported by `pracht build --analyze`.

Pracht's islands compiler is conceptually adjacent, but MCP App views should begin as their own
build target. Reusing the island runtime before the security and bridge semantics match would create
accidental coupling.

### Adapter behavior

The capability executor should use Web `Request`, `Response`, and `AbortSignal` internally. Node,
Cloudflare, and Vercel can then share protocol parsing and dispatch. Adapter-specific concerns remain
at the edge:

- maximum request and response sizes;
- streaming and connection lifetime;
- deployment context and background work;
- OAuth storage/coordination;
- rate limiting and observability hooks.

Stateful sessions must not be a prerequisite for the first release. Read and bounded write tools
should work on ordinary stateless deployments. Durable tasks, elicitation, and resumable workflows
can be later capability projections once their protocol and storage contracts are stable.

## Security Model

This feature creates a new attack surface and should ship security before convenience.

### 1. Explicit exposure

- A capability is private unless `expose.http` and/or `expose.mcp` is present.
- No API handler or route loader is inferred as a tool.
- The production build prints every externally exposed capability.
- `pracht verify` fails for exposed capabilities without an input schema, output schema, effect
  classification, or description.

### 2. Authentication is not authorization

- Streamable HTTP should follow MCP's HTTP authorization model when authentication is enabled.
- Transport code resolves credentials into a minimal principal.
- Middleware and capability code authorize that principal against the requested resource.
- Tool descriptions and MCP annotations are hints to clients, never enforcement controls.
- Browser session cookies must not silently authenticate the remote agent transport. (WebMCP page
  tools are the deliberate exception: they run in the user's tab as the signed-in user, through the
  same HTTP endpoint and policy chain as a human form submission.)
- Adapters should offer Web Bot Auth (RFC 9421 HTTP Message Signatures) verification as a request
  pipeline hook, so the principal can record *which* agent acted and on whose behalf. Signed-agent
  identity is now implemented across major CDNs and covers most identified AI-browser traffic;
  no framework surfaces it to application code yet.

### 3. Effect classes and approvals

Every capability declares one of:

| Effect | Meaning | Default exposure policy |
| --- | --- | --- |
| `read` | No externally visible mutation | May be exposed after auth/policy checks |
| `write` | Creates or changes recoverable state | Requires idempotency strategy |
| `destructive` | Deletes, publishes, pays, sends, or changes access | Requires server-verifiable confirmation |

Host-reported user approval is useful UX but not a sufficient authorization boundary. A destructive
operation should use a prepare/commit flow or a short-lived confirmation token bound to the
principal, normalized arguments, action, and expiry. The server validates that token at commit
time. The first public release can support only `read` and carefully bounded `write` effects rather
than pretending destructive approval is solved.

### 4. Transport hardening

At minimum:

- validate `Origin` according to the Streamable HTTP requirements;
- reuse adapter body-size limits and add result-size limits;
- require exact content types and protocol versions;
- apply per-principal and per-capability rate limits through middleware hooks;
- redact validation errors and internal diagnostics in production;
- emit audit events with principal, capability, effect, outcome, duration, and trace identifier;
- treat tool output as untrusted data when it includes third-party content.

### 5. UI isolation

MCP App UI resources must use the extension's sandbox and CSP model. Pracht should statically reject
obvious server-only imports in agent UI entries, expose requested permissions in build output, and
make allowed UI-to-server capability calls auditable.

## What Not to Build

- Do not make the framework choose a model or model provider.
- Do not create tools automatically from every API route.
- Do not turn arbitrary model-generated JSX into executable application code.
- Do not promise that client approval annotations secure destructive operations.
- Do not require developers to replace their existing browser UX with chat.
- Do not put MCP packages in the default client runtime.
- Do not couple the capability definition to MCP-specific result types.
- Do not begin with long-running, stateful agent workflows; establish the stateless contract first.

## Delivery Plan

### Stage 0: Architecture spike

Build one vertical demo outside the stable API:

- `projects.search` (`read`) and `projects.create` (`write`);
- JSON Schema input/output validation;
- direct server invocation and browser form invocation;
- generated `tools/list` and `tools/call` over local Streamable HTTP;
- one small Preact MCP App result view;
- Node and Cloudflare builds;
- an intentionally unauthorized cross-account call that the test proves is rejected.

The spike succeeds only if the same handler serves every invocation path, server-only imports stay
out of both browser bundles, and an MCP host without Apps support receives a useful fallback.

### Stage 1: Capability core

- `defineCapability()` and manifest registration;
- capability resolver/registry and type generation;
- schema validation and stable error mapping;
- direct invocation plus generated HTTP endpoint;
- `inspect`, `verify`, `generate`, and devtools graph support;
- unit, adapter, and E2E tests for auth separation and bundle isolation.

This stage is useful even without MCP: it gives Pracht typed server actions that are not bound to a
particular transport.

### Stage 2: Remote MCP projection

- stateless Streamable HTTP endpoint;
- tool listing/calling generated from the graph;
- authentication integration hooks and principal contract;
- structured output plus deterministic text fallback;
- effect annotations, idempotency hooks, limits, audit events, and adapter conformance tests;
- a first `pracht eval` harness: a scripted MCP client that attempts a described task
  (e.g. "find the Atlas project and archive it") against the capability graph and reports
  completion, tool-call transcript, and policy denials. No framework offers app developers a way
  to test "can an agent actually complete this task through my tools?" — this operationalizes the
  proof metrics below as repeatable CI checks, in the same spirit as Pracht's Playwright E2E story.

Read-only capabilities should be the first supported production profile.

### Stage 2b: WebMCP projection

- client-side tool registration shim behind `expose.webmcp`, active only on routes that opt in;
- shared JSON Schema reuse for tool parameters; calls dispatch through the generated HTTP endpoint
  so all enforcement stays server-side;
- devtools and `inspect` surface which routes register which page tools;
- feature-detection and graceful no-op outside the origin trial;
- explicitly disposable: if WebMCP does not graduate, the shim is removed without core changes.

### Stage 3: Preact MCP Apps projection

- separate agent UI Vite environment;
- MCP App tool/resource metadata and bridge helper;
- CSP/permission declaration and verification;
- Preact component starter and a host test harness;
- per-view asset budgets in `build --analyze`;
- graceful fallback testing for hosts without the extension.

### Stage 4: Advanced workflows

Only after the earlier contracts are proven:

- server-verifiable prepare/commit confirmations;
- resumable long-running tasks;
- progress and cancellation;
- capability composition;
- agent-facing resources and prompts;
- deployment-specific durable state helpers.

## Proof Metrics

The feature should earn its complexity. A six-week experimental cycle should answer these
questions with measured results:

| Question | Target signal |
| --- | --- |
| Does one contract actually remove duplication? | Demo has one business handler for web, HTTP, MCP, and embedded UI paths |
| Is the output understandable to agents? | Three current MCP clients complete search/create tasks without custom prompts |
| Is it still Pracht-small? | Zero added client bytes without a capability UI; initial UI view has an enforced budget |
| Can teams audit it? | `inspect` shows source, schemas, policy, effect, and every exposure |
| Is it portable? | Same demo passes Node and Cloudflare adapter conformance tests |
| Is the auth boundary real? | Cross-tenant, missing-scope, replay, oversized-body, and invalid-origin tests fail closed |
| Is fallback useful? | A host without MCP Apps can complete the same task from structured/text results |

Adoption metrics after an experimental release should focus on activated applications (a deployed,
successfully called capability), capabilities per activated app, repeat calls, schema/authorization
failure rates, and the percentage of applications using the same capability from both browser and
agent surfaces. Package downloads alone would not validate the product thesis.

## Risks and Countermeasures

| Risk | Countermeasure |
| --- | --- |
| MCP changes faster than Pracht | Keep `defineCapability` protocol-neutral and isolate MCP in a projection package |
| WebMCP dies in origin trial | Ship it as a disposable client shim over the HTTP projection; zero coupling to the core contract |
| Agent hosts never send meaningful traffic | Value must stand on web + HTTP + trust layer alone; MCP surfaces are projections, not the payoff |
| “One definition” becomes an over-generalized RPC framework | Start with explicit server operations and two transports; avoid distributed-workflow primitives |
| Developers expose unsafe mutations | Private-by-default registration, effect classes, verification failures, read-only first profile |
| OAuth implementation overwhelms the framework | Define authentication hooks first; provide deployment recipes before owning an authorization server |
| Embedded UI duplicates existing pages | Optimize for small task views; allow shared presentation components without promising full route reuse |
| Schema ergonomics are worse than API routes | Prove inference and validation in Stage 0 before stabilizing the API |
| Optional dependencies inflate normal apps | Separate package and build target, tree-shaken when no capabilities are registered |
| Agent calls are hard to debug | Capability graph, structured traces, devtools history, deterministic invocation replay fixtures |

## Decisions to Make in the Spike

1. Does JSON Schema-first provide acceptable TypeScript inference, or should Pracht accept a
   standard schema adapter that can guarantee JSON Schema emission?
2. Should browser invocation use generated HTTP endpoints, a single RPC endpoint, or both?
3. Is capability registration best in `defineApp()`, a separate `src/capabilities.ts` manifest, or
   an imported `defineCapabilities()` value referenced by the app manifest?
4. What is the smallest principal contract that works across Node, Cloudflare, and Vercel without
   prescribing an authentication library?
5. Which MCP SDK version can be isolated cleanly enough that protocol updates do not force core
   framework releases?
6. Can an MCP App Preact entry share leaf components and styles with a route without inheriting
   unsafe globals or bloating the single-resource output?
7. Which policy belongs in framework verification, and which belongs in deploy-specific middleware?
8. Can the WebMCP registration shim share the generated HTTP client helpers, and how does it
   feature-detect hosts during the origin trial without shipping dead code to every route?
9. Where does Web Bot Auth verification live in each adapter's request pipeline, and what does the
   verified agent identity look like on the principal?

## Final Recommendation

Proceed with Stage 0 as the next product exploration. Continue streaming SSR and other framework
parity work in parallel, but frame the capability graph as the next category-defining bet.

Position it as pain relief, not plumbing. “Define once, project everywhere” is the architecture;
the product is **the safest, fastest way to make a production web application usable by agents** —
because the landscape's loudest failures are unauthenticated servers, overscoped tokens, and
auto-generated tool sprawl, and the capability graph's explicit registration, effect classes,
principal contract, agent identity, and eval harness answer exactly those. Schema-to-tool
conversion is a commodity; the trust layer is the moat.

Pracht's durable advantage is not that it can bolt an MCP endpoint onto a Vite server. Many tools
can do that. The advantage is that it can compile an explicit, inspectable application graph into a
fast web product and a safe agent product — for remote agents over stateless Streamable HTTP, for
in-browser agents over WebMCP, and for embedded views with Preact, where its size is a real edge
inside sandboxed resources. No framework serves all three from one definition today. That is a
coherent extension of “full-stack Preact, per route”: **full-stack Preact, per audience**.
