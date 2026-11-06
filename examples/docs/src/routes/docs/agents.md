---
title: Agents overview
lead: "How pracht serves agents: typed capabilities over HTTP, WebMCP, and remote MCP, plus Markdown pages and `llms.txt` for reading."
---

## Agent surfaces

pracht gives agents two things: operations they can call, and pages they can read. Each surface is opt-in. An app that registers no capabilities and configures no `agents` ships none of the agent runtime.

| Surface | Use it when | Turn it on | Details |
| --- | --- | --- | --- |
| Capability over HTTP | Any client, agent or browser, should call an operation | `expose: { http: true }` | [Capabilities](/docs/capabilities) |
| WebMCP page tool | An agent in the user's browser tab should act as the signed-in user | `expose: { http: true, webmcp: true }` plus the route's `capabilities` list | [WebMCP](/docs/capabilities#webmcp-tools-for-in-browser-agents) |
| Remote MCP tool | An agent with no browser (an assistant, a scheduled job) should call your deployed app | `defineApp({ agents: { mcp } })` plus `expose: { mcp: true }` | [Remote MCP](/docs/capabilities#remote-mcp-tools-for-agents-without-a-browser) |
| Markdown by `Accept` | Agents should read a page without markup or scripts | A `markdown` export on the route | [Markdown](#discovery-markdown-and-llmstxt) |
| `.md` files | Agents that never send `Accept`, or a static host | On by default for qualifying SSG pages | [`.md` URLs](#a-md-url-for-static-markdown-pages) |
| `llms.txt` | Agents should discover your pages, endpoints, and capabilities | `pracht({ llmsTxt })` | [llms.txt](#llmstxt) |
| Agent trust | You need to know who is calling, gate destructive calls, and audit them | `defineApp({ agents })` | [Agent trust](/docs/agent-trust) |

Agents that edit your source code are a separate audience; see [Coding agents](/docs/coding-agents).

## Define a capability

Write each operation once as a capability and register it in `defineApp({ capabilities })`, next to your routes:

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

Every caller goes through the same pipeline, so the rules your UI relies on also apply to agents:

```text
input validation → middleware chain → run() → output validation → audit event
```

| Caller | How it calls |
| --- | --- |
| Your server code | `invokeCapability("appointments.book", input, { request, context })` from `@pracht/core/server` |
| Your browser code | The generated client `capabilities.appointments.book(input)` from `virtual:pracht/capabilities`, or `<Form capability>` |
| An agent in the tab | The WebMCP tool the route registers, which calls the HTTP endpoint with the user's cookies |
| An agent without a browser | `tools/call` on your app's own remote MCP endpoint (`/mcp` by default) |

Only the name, endpoint, and effect class reach the client. Importing a capability module from client code fails the build. The full API is on [Capabilities](/docs/capabilities).

## Discovery: Markdown and llms.txt

Agents also need to find and read your app. Both mechanisms below are opt-in.

### Serve Markdown by `Accept`

Export a `markdown` string from a route. A request that prefers `text/markdown` gets that string instead of rendered HTML:

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

```sh
curl -H "Accept: text/markdown" https://pracht.resynapse.dev/docs/routing
```

Markdown routes compiled by [`defineMarkdownCollection`](/docs/content), like every page on this site, get the export generated for them.

pracht switches to Markdown only when the client explicitly prefers it:

| Request header                                 | Result        |
| ---------------------------------------------- | ------------- |
| `Accept: text/html`                            | Rendered HTML |
| `Accept: */*`                                  | Rendered HTML |
| `Accept: text/markdown`                        | Raw Markdown  |
| `Accept: text/html;q=0.8, text/markdown;q=1.0` | Raw Markdown  |
| `Accept: text/html;q=1.0, text/markdown;q=0.5` | Rendered HTML |

Both representations carry `Vary: Accept`. Routes without Markdown ignore `Accept` and always serve HTML.

When middleware produces the Markdown instead, for example one dynamic route serving a document corpus, set `markdown: true` in the route metadata:

```ts [src/routes.ts]
route("/guide/:version/:name", "./routes/guide.tsx", {
  markdown: true,
  middleware: ["guideMarkdown"],
  render: "ssg",
});
```

Your middleware still does the negotiation. The flag makes adapters pass Markdown requests to it instead of serving prerendered HTML, adds `Vary: Accept`, and marks the route in `llms.txt`.

### A `.md` URL for static Markdown pages

`pracht build` writes each qualifying page's Markdown to a file next to the page, for fetchers that never send `Accept` and for static hosts that cannot negotiate. `/docs/routing` becomes `/docs/routing.md`, and `/` becomes `/index.md`:

```sh
curl https://pracht.resynapse.dev/docs/routing.md
```

The page's HTML links the file:

```html
<link rel="alternate" type="text/markdown" href="/docs/routing.md">
```

A page qualifies when its Markdown is the same for every visitor: an SSG route with a `markdown` string export and no middleware, whose build-time Markdown request succeeds without cookies. Pages marked `noindex` or sent with `Cache-Control: private` keep `Accept` negotiation only. The build prints a note naming each Markdown page left without a file and why.

A file already at that path, such as `public/docs/routing.md`, is never overwritten. `pracht dev` serves the same `.md` URLs.

To keep Markdown behind `Accept` only, turn the files off:

```ts [vite.config.ts]
pracht({ adapter: nodeAdapter(), markdownFiles: false });
```

### llms.txt

Set the Vite plugin's `llmsTxt` option to emit [`/llms.txt`](https://llmstxt.org) from your app graph:

```ts [vite.config.ts]
pracht({
  adapter: nodeAdapter(),
  llmsTxt: { origin: "https://example.com" }, // title/description default to package.json
});
```

`pracht build` writes `dist/client/llms.txt`, and the dev server serves it live at `/llms.txt`. It lists every page, every API endpoint with its methods, and every HTTP-exposed [capability](/docs/capabilities) with its endpoint, effect class, and description. A page with a `.md` file is listed by that URL; other Markdown routes are marked as supporting `Accept: text/markdown`.

An agent can then reach a validated call in two requests: read `/llms.txt`, then POST the capability endpoint. Invalid input comes back path-scoped (`/limit: must be <= 20`) so the agent can correct it.

For curated sections and full-text files with whole pages inlined, use a [`@pracht/content` collection](/docs/content) instead. This site does:

```ts [examples/docs/content.ts]
import { llmsTxtArtifacts } from "@pracht/content";
import { defineMarkdownCollection } from "@pracht/markdown";

// One entry per sidebar group (abridged).
const groups = [
  { heading: "Start here", fullPath: "/llms-start.txt", pages: ["/docs/getting-started"] },
  { heading: "Agents", fullPath: "/llms-agents.txt", pages: ["/docs/agents", "/docs/capabilities"] },
];

export const docsContent = defineMarkdownCollection({
  name: "docs",
  root: new URL("./src/routes/docs", import.meta.url),
  routeBase: "/docs",
  artifacts: [
    llmsTxtArtifacts({
      origin: "https://pracht.resynapse.dev",
      title: "pracht",
      link: (document) => `${document.path}.md`,
      sections: groups.map(({ heading, fullPath, pages }) => ({
        heading,
        fullPath,
        match: (document) => pages.includes(document.path),
      })),
    }),
  ],
});
```

That produces `/llms.txt` grouped like the sidebar, one full-text file per group such as `/llms-agents.txt`, and `/llms-full.txt` with every page:

```sh
curl https://pracht.resynapse.dev/llms.txt
curl https://pracht.resynapse.dev/llms-agents.txt
curl https://pracht.resynapse.dev/llms-full.txt
```

> [!NOTE]
> This `llms.txt` is your app's index, for agents using your site. `pracht llms` is unrelated: it prints the framework's authoring guide for a coding agent editing your repo. See [Coding agents](/docs/coding-agents#teaching-the-agent-pracht-llms-and-pracht-docs).

## Agent trust

Configure trust in `defineApp({ agents })`. Each rule applies on every transport:

- **Identity.** Agents that sign requests with Web Bot Auth ([RFC 9421](https://www.rfc-editor.org/rfc/rfc9421) HTTP Message Signatures) appear as a verified `context.agent`. On the remote MCP endpoint, OAuth adds `context.tokenAuth`: the user the agent acts for.
- **Confirmation.** A `destructive` call never runs on first contact. The server answers `confirmation_required` with a token bound to this caller, this operation, and this exact input.
- **Audit.** Every dispatch emits one structured event: capability, effect, transport, outcome, latency, and verified identity.
- **Evals.** `pracht eval` runs scripted agent tasks against your running app in CI, over HTTP or MCP `tools/call`.

The full API is on [Agent trust](/docs/agent-trust).

## Try it locally

The repository's [`examples/basic`](https://github.com/JoviDeCroock/pracht/tree/main/examples/basic) app registers five capabilities around a notes store:

```sh
git clone https://github.com/JoviDeCroock/pracht && cd pracht
pnpm install && pnpm build
cd examples/basic
PRACHT_CONFIRMATION_SECRET=dev-secret pnpm pracht dev
```

Read the index an agent would read, then call a capability:

```sh
curl -s http://localhost:3000/llms.txt

curl -s -X POST http://localhost:3000/api/capabilities/notes/search \
  -H 'content-type: application/json' -d '{"query":"capabilities"}'
# { "ok": true, "data": { "notes": [...] } }
```

Open [`/notes`](http://localhost:3000/notes) for the human UI built on the same capabilities, and `/_pracht` to watch capability calls with agent attribution. Next, try the [destructive confirmation exchange](/docs/agent-trust#destructive-capabilities-preparecommit) and [the same flow as a `pracht eval` scenario](/docs/agent-trust#pracht-eval-prove-agent-flows-in-ci).

The [`showcase`](https://github.com/JoviDeCroock/pracht/tree/main/examples/showcase) example combines browser forms, WebMCP page tools, signed remote callers, and MCP tools at `/mcp` behind one set of policies. For test patterns, including a fake WebMCP API and signed Web Bot Auth requests, see the [Testing recipe](/docs/recipes/testing).
