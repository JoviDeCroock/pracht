<p align="center">
  <a href="https://github.com/JoviDeCroock/viact">
    <img src="./assets/banner.svg" alt="pracht — Full-stack Preact, per route." width="720">
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@pracht/core"><img src="https://img.shields.io/npm/v/@pracht/core?color=8b5cf6&label=%40pracht%2Fcore" alt="npm version"></a>
  <a href="https://github.com/JoviDeCroock/viact/actions/workflows/ci.yml"><img src="https://github.com/JoviDeCroock/viact/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
</p>

# pracht

**Full-stack Preact, per route.** _(pracht /praxt/ — Dutch & German for splendor. Also: how you've always mispronounced Preact.)_

Pick SPA, SSR, SSG, or ISG on a route-by-route basis. Ship less JavaScript by default. Deploy the same codebase to Node, Cloudflare, or Vercel.

## Why pracht

- **Preact-first** — the low bundle size that you know and love with a familiar API.
- **Per-route render modes** — SPA, SSR, SSG, and ISG in the same app. No global default fighting you.
- **Explicit over magic** — a typed `defineApp()` manifest wires routes, shells, and middleware. What runs where is never a mystery. Prefer file-based routing? Opt in to the pages router and skip the manifest entirely.
- **Vite-native** — instant HMR, fast builds, multi-environment output out of the box.
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

The starter gives you:

- `pracht dev` — local SSR + HMR
- `pracht build` — client/server output plus SSG/ISG prerendering
- `pracht inspect [routes|api|build] --json` — resolved app graph metadata
- `pracht generate route|shell|middleware|api` — framework-native scaffolding
- `pracht verify` — fast framework-aware checks with `--changed` and `--json`
- `pracht doctor` — app wiring checks with optional JSON output

## Repo map

- [VISION_MVP.md](VISION_MVP.md) — scope and product direction
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — framework internals
- [docs/ROUTING.md](docs/ROUTING.md) — manifest and matching model
- [docs/RENDERING_MODES.md](docs/RENDERING_MODES.md) — SSR, SSG, ISG, SPA behavior
- [docs/DATA_LOADING.md](docs/DATA_LOADING.md) — loaders, forms, client hooks
- [docs/STYLING.md](docs/STYLING.md) — CSS Modules, Tailwind, CSS-in-JS limitations
- [docs/ADAPTERS.md](docs/ADAPTERS.md) — Node, Cloudflare, Vercel deployment paths
- [packages/start/README.md](packages/start/README.md) — starter CLI details
- [examples/basic](examples/basic), [examples/cloudflare](examples/cloudflare), [examples/docs](examples/docs) — working apps

## Contributing

Use the GitHub issue templates for bug reports and feature requests. When opening a pull request, follow [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md).
