/**
 * The pracht authoring guide for coding agents, embedded in the CLI so any
 * agent in any pracht app can get the framework's conventions without repo
 * skills: `pracht llms` prints it, `pracht llms --write` writes llms.txt,
 * and the MCP server exposes it via the `get_docs` tool.
 */
export const AUTHORING_GUIDE = `# Pracht — authoring guide for coding agents

Pracht is a full-stack Preact framework on Vite. Per-route render modes
(spa | ssr | ssg | isg), optional islands hydration, explicit routing, and
adapters for Node, Cloudflare Workers, and Vercel.

## Golden rules

1. **Scaffold, don't free-hand.** Use \`pracht generate route|shell|middleware|api\`
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

- \`src/routes.ts\` — the app manifest: \`defineApp({ shells, middleware, routes, constraints })\`.
  Every route's shell, middleware, render mode, and revalidation policy is declared here.
- \`src/routes/\` — route modules: \`Component\`, optional \`loader\`, \`head\`, \`ErrorBoundary\`, \`getStaticPaths\`.
- \`src/shells/\` — named layout wrappers (\`Shell\`, optional \`head\`, \`Loading\`).
- \`src/middleware/\` — server middleware: \`export const middleware: MiddlewareFn\`.
- \`src/server/\` — optional separate loader files wired via \`route(path, { component, loader })\`.
- \`src/api/\` — file-based API endpoints exporting HTTP method handlers (\`GET\`, \`POST\`, ...).
- \`src/islands/\` — islands components for routes with \`hydration: "islands"\`.

Pages-router apps replace the manifest with \`src/pages/\` file routing
(\`export const RENDER_MODE = "ssg"\` in the page file).

## Route example

\`\`\`ts
route("/pricing", () => import("./routes/pricing.tsx"), {
  render: "isg",
  revalidate: timeRevalidate(3600),
  shell: "public",
})
\`\`\`

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
- \`pracht inspect [routes|api|build] --json\` — resolved app graph as JSON. Prefer this over globbing \`src/\`.
- \`pracht verify [--changed] [--json]\` — deterministic framework checks; must pass before committing.
- \`pracht plan [--base ref] [--markdown]\` — semantic app-graph diff vs a git ref; \`--write\` refreshes \`.pracht/app-graph.json\`.
- \`pracht report [--base ref]\` — PR-ready markdown: graph diff + verification + budgets. Use it as the factual half of a PR description.
- \`pracht generate route|shell|middleware|api\` — canonical scaffolding; \`generate route\` also emits a Playwright smoke test when the app has an e2e setup.
- \`pracht typegen\` — typed route ids/params for \`<Link>\`, \`href()\`, \`useNavigate()\`.
- \`pracht doctor\` — app wiring diagnostics.
- \`pracht mcp\` — this CLI as an MCP server (inspect/verify/generate/docs tools).

## Finishing a change

1. \`pracht verify\` passes (and \`pracht build\` if budgets or prerendering are affected).
2. \`pracht plan --write\` if routes/API/constraints changed; commit the snapshot.
3. Run the app's tests (Playwright e2e if present).
4. Base the PR description on \`pracht report\` output; add the human "why" yourself.
`;
