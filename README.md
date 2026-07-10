<p align="center">
  <a href="https://github.com/JoviDeCroock/pracht">
    <img src="./assets/banner.svg" alt="pracht — Full-stack Preact, per route." width="720">
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@pracht/core"><img src="https://img.shields.io/npm/v/@pracht/core?color=8b5cf6&label=%40pracht%2Fcore" alt="npm version"></a>
  <a href="https://github.com/JoviDeCroock/pracht/actions/workflows/ci.yml"><img src="https://github.com/JoviDeCroock/pracht/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
</p>

# pracht

**Full-stack Preact, per route.** _(pracht /praxt/ — Dutch & German for splendor. Also: how you've always mispronounced Preact.)_

Pick SPA, SSR, SSG, or ISG on a route-by-route basis. Ship less JavaScript by default. Deploy the same codebase to Node, Cloudflare, or Vercel.

## Why pracht

- **Preact-first** — the low bundle size that you know and love with a familiar API.
- **Per-route render modes** — SPA, SSR, SSG, and ISG in the same app. No global default fighting you.
- **Explicit over magic** — a typed `defineApp()` manifest wires routes, shells, and middleware. What runs where is never a mystery. Prefer file-based routing? Opt in to the pages router and skip the manifest entirely.
- **Vite-native** — instant HMR, fast builds, multi-environment output out of the box.
- **Performance budgets built in** — `pracht build --analyze` reports per-route client JS (gzip + raw), and per-route `budgets` fail the build when a route ships too much.
- **Deploy anywhere** — one codebase, one build, three production-ready adapters (Node, Cloudflare Workers, Vercel).

## At a glance

Two routing styles, your choice:

**Manifest routing** — full control, explicit wiring:

```ts
// src/routes.ts
import { defineApp, group, route, timeRevalidate } from "@pracht/core";

export const app = defineApp({
  shells: {
    app: () => import("./shells/app.tsx"),
    public: () => import("./shells/public.tsx"),
  },
  middleware: {
    auth: () => import("./middleware/auth.ts"),
  },
  routes: [
    group({ shell: "public" }, [
      route("/", () => import("./routes/home.tsx"), { render: "ssg" }),
      route("/pricing", () => import("./routes/pricing.tsx"), {
        render: "isg",
        revalidate: timeRevalidate(3600),
      }),
    ]),
    group({ shell: "app", middleware: ["auth"] }, [
      route("/dashboard", () => import("./routes/dashboard.tsx"), { render: "ssr" }),
      route("/settings", () => import("./routes/settings.tsx"), { render: "spa" }),
    ]),
  ],
});
```

One manifest. Four render strategies. No renaming folders to change behavior.

**Pages router** — file-based, zero manifest:

```ts
// vite.config.ts
export default defineConfig({
  plugins: [pracht({ pagesDir: "/src/pages", adapter: nodeAdapter() })],
});
```

```
src/pages/
  index.tsx        → /
  blog/[slug].tsx  → /blog/:slug
```

Same render modes, same adapters — just let the filesystem drive.

## Create an app

```bash
npm create pracht@latest my-app
```

The prompts cover the target directory, hosting adapter (Node.js, Cloudflare Workers, Vercel), router (manifest or pages), and optional Tailwind CSS. For non-interactive runs pass flags instead — e.g. `--template=tailwind` (or `--template=minimal`), `--adapter=node`, `--no-git`, `--yes`. See [packages/start/README.md](packages/start/README.md) for the full list.

The starter gives you:

- `pracht dev` — local SSR + HMR, a `/_pracht` devtools page with the resolved route/API graph (JSON at `/_pracht.json`), and `Server-Timing` middleware/loader/render phase timings on every dev SSR response
- `pracht build` — client/server output plus SSG/ISG prerendering, with `--analyze` for a per-route client JS report and budget enforcement
- `pracht preview` — build and serve the production build locally
- `pracht inspect [routes|api|capabilities|build] --json` — resolved app graph metadata
- `pracht generate route|shell|middleware|api` — framework-native scaffolding
- `pracht verify` — fast framework-aware checks with `--changed` and `--json`
- `pracht doctor` — app wiring checks with optional JSON output
- Optional Tailwind CSS wiring, a git repo with an initial commit, and (for the Node adapter) a multi-stage `Dockerfile`

## AI-assisted development

Pracht is built to be operated by coding agents as much as by humans:

- **MCP server** — `pracht mcp` starts a stdio [Model Context Protocol](https://modelcontextprotocol.io) server so agents can natively inspect the resolved app graph, run doctor/verify diagnostics, and scaffold routes, shells, middleware, and API handlers. See [docs/MCP.md](docs/MCP.md) for registration and the tool reference.
- **Capabilities & WebMCP** — `@pracht/capabilities` lets you define a typed application operation once (JSON Schema contract, effect class, middleware) and project it to server code, a generated HTTP endpoint, and a WebMCP page tool for in-browser agents — private by default, with `pracht verify` enforcing the security defaults. See [docs/CAPABILITIES.md](docs/CAPABILITIES.md).
- **Agent trust layer** — Web Bot Auth (RFC 9421) verified agent identity on the request context with observe/require policies, a prepare/commit confirmation flow for destructive capabilities, capability audit events, and `pracht eval` for scripted agent-task checks in CI. See [docs/AGENT_TRUST.md](docs/AGENT_TRUST.md).
- **Claude Code skills** — repo-local skills for scaffolding, auditing, debugging, and deploying pracht apps live in [skills/](skills/README.md).

## Repo map

- [VISION_MVP.md](VISION_MVP.md) — scope and product direction
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — framework internals
- [docs/ROUTING.md](docs/ROUTING.md) — manifest and matching model
- [docs/RENDERING_MODES.md](docs/RENDERING_MODES.md) — SSR, SSG, ISG, SPA behavior
- [docs/PERFORMANCE.md](docs/PERFORMANCE.md) — bundle analysis and per-route client JS budgets
- [docs/DATA_LOADING.md](docs/DATA_LOADING.md) — loaders, forms, client hooks
- [docs/CAPABILITIES.md](docs/CAPABILITIES.md) — typed capabilities, HTTP projection, WebMCP page tools
- [docs/AGENT_TRUST.md](docs/AGENT_TRUST.md) — Web Bot Auth, effect-class confirmation flow, audit hook, `pracht eval`
- [docs/STYLING.md](docs/STYLING.md) — CSS Modules, Tailwind, CSS-in-JS limitations
- [docs/ADAPTERS.md](docs/ADAPTERS.md) — Node, Cloudflare, Vercel deployment paths
- [docs/MCP.md](docs/MCP.md) — built-in MCP server for coding agents
- [packages/start/README.md](packages/start/README.md) — starter CLI details
- [packages/preact-worker-facets/README.md](packages/preact-worker-facets/README.md) — experimental Cloudflare Dynamic Worker facets runtime for Preact components
- [examples/basic](examples/basic), [examples/cloudflare](examples/cloudflare), [examples/docs](examples/docs) — working apps

## Contributing

Use the GitHub issue templates for bug reports and feature requests. When opening a pull request, follow [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md).
