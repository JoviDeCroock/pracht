/**
 * The pracht authoring guide for coding agents, embedded in the CLI so any
 * agent in any pracht app can get the framework's conventions without repo
 * skills: `pracht llms` prints it, `pracht llms --write` writes llms.txt,
 * and the MCP server exposes it via the `get_docs` tool.
 */
export const AUTHORING_GUIDE = `# Pracht — authoring guide for coding agents

Pracht is a full-stack Preact framework on Vite. Per-route render modes
(spa | ssr | ssg | isg), optional islands hydration, explicit routing, and
adapters for Node, Cloudflare Workers, Netlify, and Vercel.

## Golden rules

1. **Scaffold, don't free-hand.** Use \`pracht generate route|shell|middleware|api|capability\`
   (or the MCP generate_* tools) to create files — the wiring is machine-made
   and canonical. Then edit only component and loader bodies.
2. **Verify before you finish.** \`pracht verify\` runs deterministic checks:
   manifest wiring, env leaks, budgets, declared constraints, and app-graph
   snapshot freshness. It must pass. \`pracht verify --changed\` is the fast loop.
3. **Keep the graph snapshot fresh.** If the app commits \`.pracht/app-graph.json\`,
   run \`pracht plan --write\` after changing routes and commit the result.
   \`pracht plan\` shows reviewers an intent-level diff of your change.
4. **Server code stays server-side.** Loaders and middleware run on the server.
   Never import browser-only APIs there; never return non-serializable loader data.
5. **Env safety.** Client-visible env vars must be prefixed \`PRACHT_PUBLIC_\`.
   Use the typed \`serverEnv\`/\`publicEnv\` helpers; builds fail on leaks.

## Project layout (manifest apps)

- \`src/routes.ts\` — the app manifest: \`defineApp({ shells, middleware, routes, notFound, constraints })\`.
  Every route's shell, middleware, render mode, and revalidation policy is declared here.
  \`notFound\` names the page rendered with a 404 status when nothing matches — it is
  not a route, so never add a catch-all \`route("/*", ...)\` for that purpose.
- \`src/routes/\` — route modules: \`Component\`, optional \`loader\`, \`head\`, \`ErrorBoundary\`, \`getStaticPaths\`.
- \`src/shells/\` — named layout wrappers (\`Shell\`, optional \`head\`, \`Loading\`).
- \`src/middleware/\` — server middleware: \`export const middleware: MiddlewareFn\`.
- \`src/server/\` — optional separate loader files wired via \`route(path, { component, loader })\`.
- \`src/api/\` — file-based API endpoints exporting HTTP method handlers (\`GET\`, \`POST\`, ...).
- \`src/islands/\` — islands components for routes with \`hydration: "islands"\`.
- \`src/capabilities/\` — typed application operations (see below).

Pages-router apps replace the manifest with \`src/pages/\` file routing
(\`export const RENDER_MODE = "ssg"\` in the page file). Pages ISG also requires
\`export const REVALIDATE = 3600\`; it supports time policies only and fails
build/doctor/verify when the policy is missing or misplaced, including on
\`_app\` or \`404\`. Fenced Markdown/MDX examples are ignored. Middleware is a
single root-level \`src/pages/_middleware.ts\` (\`export const middleware:
MiddlewareFn\`) applied to every page route — nested or per-route middleware is
not supported, and API routes are not wrapped. **The pages router has no
manifest, so it has no capabilities, constraints, or \`agents\`** — if a task
needs per-route auth or the agent surface, use manifest routing (or eject with
\`generateRoutesFile\`).

## Route example

\`\`\`ts
route("/pricing", () => import("./routes/pricing.tsx"), {
  render: "isg",
  revalidate: timeRevalidate(3600),
  shell: "public",
})
\`\`\`

## Capabilities (the agent surface)

A capability is one typed application operation — JSON Schema input/output, an
effect class, optional named middleware, a server-only \`run()\` — that pracht
projects to several surfaces from one contract: direct server calls
(\`invokeCapability\`), a generated HTTP endpoint, a WebMCP page tool, a remote
MCP tool, and the human UI via \`<Form capability>\`. Use one whenever an
operation should be callable by both a person and an agent; keep file uploads
and non-JSON payloads in API routes.

**Install the package first** — capability modules import it and it is not part
of the default scaffold:

\`\`\`bash
npm install @pracht/capabilities
\`\`\`

\`\`\`ts
// src/capabilities/notes-search.ts
import { defineCapability, type CapabilityRunArgs } from "@pracht/capabilities";

export default defineCapability({
  title: "Search notes",
  description: "Find notes whose title or body matches the query.",
  input: {
    type: "object",
    properties: { query: { type: "string", minLength: 1 } },
    required: ["query"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: { notes: { type: "array", items: { type: "object" } } },
    required: ["notes"],
  },
  effect: "read",                       // read | write | destructive
  expose: { http: true, webmcp: true }, // omit \`expose\` to keep it private
  async run({ input }: CapabilityRunArgs<{ query: string }>) {
    return { notes: await searchNotes(input.query) };
  },
});
\`\`\`

\`pracht generate capability --name notes.search --effect read --expose http,webmcp\`
writes this skeleton and registers it for you.

Register it in the manifest, like shells and middleware:

\`\`\`ts
defineApp({ capabilities: { "notes.search": "./capabilities/notes-search.ts" } })
\`\`\`

Rules that are enforced, not advisory:

- **Private by default.** No \`expose\` means no network surface at all.
- **\`effect\` is a security classification.** \`destructive\` (delete, publish,
  pay, send, change access) may only use \`expose.http\`, is gated by a
  prepare/commit confirmation flow, and needs \`PRACHT_CONFIRMATION_SECRET\` in
  the deployed environment. Exposing it over \`webmcp\`/\`mcp\` is an error.
  Never downgrade an effect class to make a call easier — that is a policy
  change a human must approve.
- **\`expose\`, \`effect\`, and \`input\` must be inline literals.** The browser
  projection is built by static analysis; imported constants and spreads fail
  the build.
- **Exposed capabilities need a full contract** — description, input schema,
  output schema, effect — or \`pracht verify\` fails.
- **Schemas are a JSON Schema subset.** \`oneOf\`/\`anyOf\`/\`allOf\`/\`$ref\`/
  \`pattern\`/\`format\` are rejected at definition time.
- Remote MCP additionally needs \`defineApp({ agents: { mcp: {} } })\`, and both
  schemas rooted at \`{ type: "object" }\`. Dotted names become underscored tool
  names (\`notes.search\` → \`notes_search\`).

Call sites: \`invokeCapability(name, input, args)\` from loaders/API routes/
middleware; \`callCapability\` / \`useCapability\` / the generated \`capabilities\`
client from \`virtual:pracht/capabilities\` in the browser; \`<Form capability>\`
for the human path (it revalidates route data after a successful non-read
call). Never import a capability module from client code — that is a build
error, because it would bundle \`run()\` and its server dependencies.

Inspect with \`pracht inspect capabilities --json\`; test scripted agent flows
with \`pracht eval\` (scenario files in \`evals/*.eval.json\`, \`--start\` boots the
app itself).

## Constraints (invariants reviewers rely on)

\`defineApp({ constraints: [...] })\` declares invariants that \`pracht verify\` enforces:

\`\`\`ts
constraints: [
  requireMiddleware("/app/**", "auth"),
  requireShell("/app/**", "app"),
  forbidRenderMode("/app/**", "ssg", "isg"),
  requireHead("**"),
]
\`\`\`

Never delete or weaken a constraint to make verification pass — that is a
policy change a human must approve.

## Commands

- \`pracht dev\` — dev server with HMR; \`/_pracht\` shows the resolved graph (JSON at \`/_pracht.json\`).
- \`pracht build [--analyze]\` — production build; \`--analyze\` reports per-route client JS; budgets fail the build.
- \`pracht inspect [routes|api|capabilities|build] --json\` — resolved app graph as JSON. Prefer this over globbing \`src/\`.
- \`pracht verify [--changed] [--json]\` — deterministic framework checks; must pass before committing.
- \`pracht plan [--base ref] [--markdown]\` — semantic app-graph diff vs a git ref; \`--write\` refreshes \`.pracht/app-graph.json\`.
- \`pracht report [--base ref]\` — PR-ready markdown: graph diff + verification + budgets. Use it as the factual half of a PR description.
- \`pracht generate route|shell|middleware|api|capability\` — canonical scaffolding; \`generate route\` also emits a Playwright smoke test when the app has an e2e setup.
- \`pracht typegen\` — typed route ids/params for \`<Link>\`, \`href()\`, \`useNavigate()\`.
- \`pracht eval [files] [--url] [--start "<cmd>"]\` — run scripted agent-task scenarios against the capability HTTP projection; exits 1 on any failed expectation.
- \`pracht doctor\` — app wiring diagnostics.
- \`pracht mcp\` — this CLI as an MCP server (inspect/verify/generate/docs tools).

## Finishing a change

1. \`pracht verify\` passes (and \`pracht build\` if budgets or prerendering are affected).
2. \`pracht plan --write\` if routes/API/capabilities/constraints changed; commit the snapshot.
3. Run the app's tests (Playwright e2e if present).
4. Base the PR description on \`pracht report\` output; add the human "why" yourself.
`;
