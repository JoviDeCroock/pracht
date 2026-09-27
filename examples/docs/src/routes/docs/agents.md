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

When an AI agent needs to book a slot or file a ticket today, it scrapes: load the page, read the DOM, guess which `<button>` is real, and click. That is slow, brittle, and anonymous, and the same guessing that fills a search box can hit "delete account."

Your app already knows its own operations. pracht asks you to write each one down **once**, in a form a machine can trust:

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

Register it in the same `defineApp()` manifest as your routes, shells, and middleware, and pracht projects that one contract everywhere.

---

## One Graph, Four Projections

pracht resolves the manifest once and aims it at four audiences.

**Your own code.** A loader calls `invokeCapability("appointments.book", …)` and gets the same validation, middleware, and pipeline. The human UI and the agent surface are the same function, so they cannot drift.

**The browser.** An island calls the generated `capabilities.appointments.book({ … })` client, or a `<Form capability>` posts to it without JavaScript. Only the name, endpoint, and effect class reach the client; importing the capability module from client code fails the build.

**An agent in the user's tab.** With `expose.webmcp` and the capability listed in a route's `capabilities`, the page registers it as a [WebMCP](https://developer.chrome.com/docs/ai/webmcp) tool. Navigating away swaps in the next route's tools. The agent acts as the signed-in user, and every check still runs on your server.

**An agent without a browser.** With `expose.mcp`, the same contract is a tool on your app's own remote MCP endpoint at `/mcp`. No SDK, no second server, and the same validation, middleware, identity checks, and audit events.

Every projection runs one pipeline:

```text
input validation → middleware chain → run() → output validation → audit event
```

The full API is on [Capabilities](/docs/capabilities).

---

## Discovery: Markdown and llms.txt

Agents also need to find and read your app. Both mechanisms below are opt-in.

### One URL, Two Representations

A route can serve both rendered HTML and raw Markdown. Browsers get HTML; agents that ask for Markdown get the source document without navigation or hydration noise.

```sh
# Human-readable HTML
curl https://pracht.resynapse.dev/docs/routing

# Agent-readable Markdown
curl -H "Accept: text/markdown" https://pracht.resynapse.dev/docs/routing
```

A route opts in by exporting a `markdown` string. When the request prefers `text/markdown`, pracht returns it without rendering:

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

Markdown routes compiled by [`defineMarkdownCollection`](/docs/content), like every page on this site, get that export generated for them.

If middleware produces the Markdown instead, for example one dynamic route serving a document corpus, declare it in route metadata:

```ts [src/routes.ts]
route("/guide/:version/:name", "./routes/guide.tsx", {
  markdown: true,
  middleware: ["guideMarkdown"],
  render: "ssg",
});
```

Your middleware still does the negotiation. The flag makes adapters let Markdown requests reach it instead of serving prerendered HTML, adds `Vary: Accept`, and annotates the route in `llms.txt`.

pracht switches to Markdown only when the client explicitly prefers it:

| Request header                                 | Result        |
| ---------------------------------------------- | ------------- |
| `Accept: text/html`                            | Rendered HTML |
| `Accept: */*`                                  | Rendered HTML |
| `Accept: text/markdown`                        | Raw Markdown  |
| `Accept: text/html;q=0.8, text/markdown;q=1.0` | Raw Markdown  |
| `Accept: text/html;q=1.0, text/markdown;q=0.5` | Rendered HTML |

Both representations carry `Vary: Accept`, so caches keep them apart. Routes without Markdown ignore `Accept` and always serve HTML.

### llms.txt

The Vite plugin's `llmsTxt` option emits [`/llms.txt`](https://llmstxt.org) from your app graph: every page, every API endpoint with its methods, and every HTTP-exposed [capability](/docs/capabilities) with its endpoint, effect class, and description. Markdown routes are marked as supporting `Accept: text/markdown`.

```ts [vite.config.ts]
pracht({
  adapter: nodeAdapter(),
  llmsTxt: { origin: "https://example.com" }, // title/description default to package.json
});
```

`pracht build` writes `dist/client/llms.txt`; the dev server serves it live at `/llms.txt`.

An agent can go from "never heard of this site" to a validated call in two requests: read `/llms.txt`, then POST the capability endpoint. A wrong input comes back path-scoped (`/limit: must be <= 20`) so the agent can correct itself.

For curated sections and an `llms-full.txt` bundle with full page content, use the [`@pracht/content` collection](/docs/content) instead. This site does:

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

That yields `/llms.txt`, a map of titles, descriptions, and URLs, plus `/llms-full.txt`, one Markdown bundle with every listed page:

```sh
curl https://pracht.resynapse.dev/llms.txt
curl https://pracht.resynapse.dev/llms-full.txt
```

> [!NOTE]
> `llms.txt` here means *your app's* index, generated from *your* graph. `pracht llms` is a different thing: it prints the framework's own authoring guide for a coding agent working in your repo. See [Coding Agents](/docs/coding-agents#teaching-the-agent-pracht-llms).

---

## Trust Is the Framework's Job

Turning schemas into tools is the easy part. What makes an agent surface deployable is the trust layer, and pracht ships it in the framework:

- **Who is calling?** Agents that sign with Web Bot Auth ([RFC 9421](https://www.rfc-editor.org/rfc/rfc9421) HTTP Message Signatures) appear as a verified `context.agent`. On the remote MCP endpoint, OAuth also identifies *on whose behalf* the agent acts.
- **May they do this?** A `destructive` call cannot run on first contact. The server answers `confirmation_required` with a token bound to this caller, this operation, and this exact input.
- **What happened?** Every dispatch emits one structured audit event: capability, effect, transport, outcome, latency, and verified identity.
- **Will it keep working?** `pracht eval` runs scripted agent tasks against your live app in CI, over HTTP or real MCP `tools/call`.

The full API is on [Agent Trust](/docs/agent-trust).

---

## Try It in Five Minutes

Everything above works with plain `curl`. The repository's [`examples/basic`](https://github.com/JoviDeCroock/pracht/tree/main/examples/basic) app registers five capabilities around a notes store:

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

Visit [`/notes`](http://localhost:3000/notes) for the human side of the same contracts, and `/_pracht` to watch capability traffic with agent attribution. Then continue on Agent Trust with the [destructive confirmation exchange](/docs/agent-trust#destructive-capabilities-preparecommit) and [the same flow as a `pracht eval` scenario](/docs/agent-trust#pracht-eval-prove-agent-flows-in-ci).

The [`showcase`](https://github.com/JoviDeCroock/pracht/tree/main/examples/showcase) example goes further: six operations projected to the browser, progressively enhanced forms, in-page WebMCP agents, signed remote callers, and MCP tools at `/mcp`, behind one set of policies.

---

## Where to Go Next

| Page | What it covers |
| --- | --- |
| [Capabilities](/docs/capabilities) | `defineCapability`, `expose.http`/`webmcp`/`mcp`, effect classes, typed clients, `<Form capability>`, and the remote MCP endpoint |
| [Agent Trust](/docs/agent-trust) | Web Bot Auth, `agentPolicy`, the confirmation flow, approval stores, audit sinks, `pracht eval` |
| [Coding Agents](/docs/coding-agents) | The other kind of agent: `pracht dev-mcp`, Claude Code skills, constraints, app-graph snapshots, `pracht plan`/`report` |
| [Testing](/docs/recipes/testing) | Vitest, Playwright, faking the WebMCP API, signing Web Bot Auth requests |

Not built yet: MCP Apps UI views, where a capability returns interactive Preact UI into an agent's chat.
