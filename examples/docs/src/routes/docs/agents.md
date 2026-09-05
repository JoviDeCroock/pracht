---
title: The Agentic Web
lead: "The web has two users now — people, and the agents acting on their behalf. pracht resolves your app into one explicit graph and projects that graph to both: components for humans, typed and trust-gated tools for agents."
breadcrumb: Agents
prev:
  href: /docs/performance
  title: Performance
next:
  href: /docs/capabilities
  title: Capabilities
---

## The Web Has Two Users Now

Today, when an AI agent needs to do something on a website — book a slot, file a ticket, buy the thing — it does what a scraper does: load the page, read the DOM, guess which `<button>` is real, and click. That is slow, brittle, and anonymous. And the same guessing that fills a search box can also hit "delete account." The site owner cannot tell agents from humans, cannot say which operations are safe, and finds out what happened from the support queue.

pracht's bet: your app already knows its own operations — it has just never written them down in a form a machine could trust. So you write each one down **once**:

```ts [src/capabilities/book-appointment.ts]
import { defineCapability } from "@pracht/capabilities";

export default defineCapability({
  title: "Book appointment",
  description: "Reserve an open slot with the given service and time.",
  input: { /* JSON Schema */ },
  output: { /* JSON Schema */ },
  effect: "write",
  middleware: ["auth"],
  expose: { http: true, webmcp: true, mcp: true },
  async run({ input, context }) { /* your business logic */ },
});
```

Register it in the same `defineApp()` manifest that already holds your routes, shells, middleware, and API routes, and it joins the app graph. One contract. pracht projects it everywhere.

---

## One Graph, Four Projections

The manifest is not a routing config that happens to be explicit. It is a description of the application, which the framework resolves once and then aims at four different audiences.

**Your own code.** The loader behind the booking page calls `invokeCapability("appointments.book", …)` — same schema validation, same named middleware, same pipeline. The human UI and the agent surface cannot drift apart, because they are the same function.

**The browser.** Your island's click handler calls the generated `capabilities.appointments.book({ … })` client, or a `<Form capability>` posts to it with no JavaScript at all. The capability module never ships to the client: only its name, endpoint, and effect class cross, and importing the module from client code fails the build.

**An agent standing in the user's tab.** With `expose.webmcp` and the capability named in that route's `capabilities` list, the page registers the operation as a [WebMCP](https://developer.chrome.com/docs/ai/webmcp) page tool. Navigating away replaces it with the destination route's tool set. The agent stops guessing at your DOM and instead reads: *"book_appointment — reserve an open slot. Input: service, time."* It acts as the signed-in user, in their session, and every check still runs on your server.

**An agent that never opens a browser.** With `expose.mcp`, the same contract is served as a tool on your app's own remote MCP endpoint — `initialize`, `tools/list`, `tools/call`, straight over HTTP. No SDK, no second server, no separate tool definitions to keep in sync. An MCP host points at `https://your-app/mcp` and gets the same validation, middleware, identity checks, and audit events every other caller gets.

Every projection runs one pipeline:

```text
input validation → middleware chain → run() → output validation → audit event
```

There is no second copy of the rules that could drift from the first. The full API — `defineCapability`, `expose`, effect classes, typed clients, `<Form capability>`, and the remote MCP transport — is on [Capabilities](/docs/capabilities).

---

## Discovery: Markdown and llms.txt

A projection nobody can find is not a projection. Two mechanisms make the graph discoverable, and both are opt-in.

### One URL, Two Representations

pracht can serve the same route as either a normal HTML page or raw Markdown. Browsers keep receiving rendered HTML; agents that explicitly ask for Markdown get the source document with no navigation chrome, hydration state, or scraped layout noise.

```sh
# Human-readable HTML
curl https://pracht.resynapse.dev/docs/routing

# Agent-readable Markdown
curl -H "Accept: text/markdown" https://pracht.resynapse.dev/docs/routing
```

Any route opts in by exporting a `markdown` string. When the incoming request prefers `text/markdown`, pracht returns that string before running the render pipeline:

```tsx [src/routes/pricing.tsx]
export const markdown = `# Pricing

- Starter: free
- Pro: usage-based
- Enterprise: contact sales
`;

export function Component() {
  return <PricingPage />;
}
```

Markdown route modules compiled by [`defineMarkdownCollection`](/docs/content) — which is how every page on this site is built — get that export generated for them, so a docs site becomes an agent-readable endpoint without writing anything.

If middleware generates the Markdown instead — one dynamic route module serving a large document corpus, say — declare it in route metadata:

```ts [src/routes.ts]
route("/guide/:version/:name", "./routes/guide.tsx", {
  markdown: true,
  middleware: ["guideMarkdown"],
  render: "ssg",
});
```

The middleware still performs the negotiation. The declaration makes the build record concrete prerendered paths, keeps adapters from serving HTML ahead of middleware, adds `Vary: Accept`, and annotates the generated `llms.txt`. A module `markdown` export is detected automatically.

pracht only switches to Markdown when the client explicitly prefers it. Browser-style wildcards still receive HTML:

| Request header                                 | Result        |
| ---------------------------------------------- | ------------- |
| `Accept: text/html`                            | Rendered HTML |
| `Accept: */*`                                  | Rendered HTML |
| `Accept: text/markdown`                        | Raw Markdown  |
| `Accept: text/html;q=0.8, text/markdown;q=1.0` | Raw Markdown  |
| `Accept: text/html;q=1.0, text/markdown;q=0.5` | Rendered HTML |

Both representations carry `Vary: Accept`, so caches keep them separate. Routes without a `markdown` export do not vary on `Accept`; their prerendered document answers markdown-preferring requests instead of falling through to a server render. Adapters skip static HTML asset serving for Markdown requests, so SSG routes can negotiate through the framework.

### llms.txt

The vite plugin's `llmsTxt` option emits [`/llms.txt`](https://llmstxt.org) from the resolved app graph: every page URL, every API endpoint with its methods, and every HTTP-exposed [capability](/docs/capabilities) with its dispatch endpoint, effect class, and description. Routes that negotiate Markdown are annotated with `` supports `Accept: text/markdown` ``.

```ts [vite.config.ts]
pracht({
  adapter: nodeAdapter(),
  llmsTxt: { origin: "https://example.com" }, // title/description default to package.json
});
```

`pracht build` writes `dist/client/llms.txt`; the dev server serves it live at `/llms.txt`.

An agent goes from "never heard of this site" to a validated, typed call in two requests — read `/llms.txt`, then POST the capability endpoint. When it gets the input wrong, the error comes back path-scoped (`/limit: must be <= 20`) so it self-corrects instead of flailing.

Sites that want curated sections and an `llms-full.txt` bundle with inlined page content use the [`@pracht/content` collection](/docs/content) instead, which owns Markdown compilation and artifact generation together. This site does:

```ts [examples/docs/content.ts]
import { llmsTxtArtifacts } from "@pracht/content";
import { defineMarkdownCollection } from "@pracht/markdown";

export const docsContent = defineMarkdownCollection({
  name: "docs",
  root: new URL("./src/routes/docs", import.meta.url),
  routeBase: "/docs",
  artifacts: [
    llmsTxtArtifacts({
      origin: "https://pracht.resynapse.dev",
      title: "pracht",
      sections: [{ heading: "Docs", match: "/docs" }],
    }),
  ],
});
```

That yields `/llms.txt` — a concise map with titles, descriptions, and canonical URLs — plus `/llms-full.txt`, a single Markdown bundle with the full source of every listed page:

```sh
curl https://pracht.resynapse.dev/llms.txt
curl https://pracht.resynapse.dev/llms-full.txt
```

No second plugin scans the route manifest or reparses frontmatter; the same registry that compiles the Markdown routes emits both files.

> [!NOTE]
> `llms.txt` here means *your app's* index, generated from *your* graph. `pracht llms` is a different thing: it prints the framework's own authoring guide for a coding agent working in your repo. See [Coding Agents](/docs/coding-agents#teaching-the-agent-pracht-llms).

---

## Trust Is the Framework's Job

Turning schemas into tools is commodity work. What makes an agent surface deployable rather than a demo is the trust layer, and in pracht it ships in the framework, so it is the default rather than a bolt-on. Three questions, three answers:

- **Who is calling?** Agents signing with Web Bot Auth ([RFC 9421](https://www.rfc-editor.org/rfc/rfc9421) HTTP Message Signatures, the standard the major CDNs are rolling out) surface as `context.agent`, cryptographically verified. On the remote MCP endpoint, OAuth resource-server metadata additionally identifies *on whose behalf* the agent acts.
- **May they do this?** Effect classes are load-bearing, not documentation. A `destructive` call cannot run on first contact: the server answers `confirmation_required` with a token bound to this caller, this operation, and this exact input.
- **What happened?** Every dispatch emits one structured audit event — capability, effect, transport, outcome, latency, verified identity. Your agent traffic is a queryable log rather than a mystery in the access logs.

And one more, because a surface nobody tests is a surface that rots: **will it keep working?** `pracht eval` runs scripted agent tasks against your live app in CI, over the HTTP projection or over real MCP `tools/call`, so the thing you advertise to hosts is the thing you actually test.

The full API lives in [Agent Trust](/docs/agent-trust).

---

## Try It in Five Minutes

Everything above is reachable with nothing but `curl`. The repository's [`examples/basic`](https://github.com/JoviDeCroock/pracht/tree/main/examples/basic) app registers five capabilities around a notes store:

```sh
git clone https://github.com/JoviDeCroock/pracht && cd pracht
pnpm install && pnpm build
cd examples/basic
PRACHT_CONFIRMATION_SECRET=dev-secret pnpm pracht dev
```

Discover the app the way an agent would, then call a capability:

```sh
curl -s http://localhost:3000/llms.txt

curl -s -X POST http://localhost:3000/api/capabilities/notes/search \
  -H 'content-type: application/json' -d '{"query":"capabilities"}'
# { "ok": true, "data": { "notes": [...] } }
```

Then visit [`/notes`](http://localhost:3000/notes) to see the human projection of the same contracts, and `/_pracht` to watch the capability traffic with agent attribution. Agent Trust carries the rest of the walkthrough: the [destructive confirmation exchange](/docs/agent-trust#destructive-capabilities-preparecommit) as two `curl`s, and [the same flow replayed as a `pracht eval` scenario](/docs/agent-trust#pracht-eval-prove-agent-flows-in-ci) over HTTP and over real MCP `tools/call`.

The [`showcase`](https://github.com/JoviDeCroock/pracht/tree/main/examples/showcase) example is the fuller version: six operations projected to the browser, to progressively-enhanced forms, to in-page WebMCP agents, to signed remote callers, and to MCP tools at `/mcp`, behind one set of policies.

---

## Where to Go Next

| Page | What it covers |
| --- | --- |
| [Capabilities](/docs/capabilities) | `defineCapability`, `expose.http`/`webmcp`/`mcp`, effect classes, typed clients, `<Form capability>`, and the remote MCP endpoint |
| [Agent Trust](/docs/agent-trust) | Web Bot Auth, `agentPolicy`, the confirmation flow, approval stores, audit sinks, `pracht eval` |
| [Coding Agents](/docs/coding-agents) | The other kind of agent: `pracht dev-mcp`, Claude Code skills, constraints, app-graph snapshots, `pracht plan`/`report` |
| [Testing](/docs/recipes/testing) | Vitest, Playwright, faking the WebMCP API, signing Web Bot Auth requests |

Not built yet: MCP Apps UI views, where a capability returns interactive Preact UI into an agent's chat. The contracts are already written down, so that is one more projection rather than a new API.

The one-liner: other frameworks render your app for humans and leave agents to scrape it. pracht projects one explicit app graph to both.
