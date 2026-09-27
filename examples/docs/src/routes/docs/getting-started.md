---
title: Getting Started
lead: Create a pracht app, run it locally, and ship your first production build.
breadcrumb: Getting Started
next:
  href: /docs/why-pracht
  title: Why Pracht?
---

## Requirements

Node 22.18 or newer. Scaffolded apps include an `.nvmrc` and an `engines.node`
field, so hosts and CI pick a supported version.

## Create a Project

```sh
# pnpm
pnpm create pracht my-app

# npm
npm create pracht@latest my-app

# yarn
yarn create pracht my-app

# bun
bunx create-pracht my-app
```

The CLI asks for:

- an adapter: Node.js, Cloudflare Workers, Netlify, Vercel, or a static export
  (you can switch later in `vite.config.ts`);
- a router: the explicit `src/routes.ts` manifest, or file-system `src/pages/`;
- whether to add Tailwind CSS;
- whether to add agent tooling.

The pages router can be ejected to a manifest later, when you need per-route
shells or middleware, explicit route ids, path-prefix groups, or webhook ISG.
See [Pages Router](/docs/routing#pages-router-auto-discovery).

For CI, demos, or agents, pass the choices as flags:

```sh
pnpm create pracht my-app --adapter=node --router=manifest --template=tailwind --yes
pnpm create pracht my-app --adapter=cf --router=pages --no-tailwind --no-agent-tools --yes
pnpm create pracht my-app --adapter=vercel --skip-install --yes
```

- `--adapter=node|cf|netlify|vercel|static` chooses the deployment target.
- `--router=manifest|pages` chooses the router.
- `--template=minimal|tailwind`, `--tailwind`, and `--no-tailwind` control styling.
- `--agent-tools[=core|full]` and `--no-agent-tools` control `.claude/skills/`,
  `.mcp.json`, and `AGENTS.md`/`CLAUDE.md`.
- `--yes` accepts defaults. `--skip-install`, `--no-git`, `--json`, and
  `--dry-run` help with automation.

---

## Project Structure

A manifest-router scaffold looks like this:

```
my-app/
  src/
    routes.ts          # Route manifest (the central wiring file)
    routes/home.tsx    # First page component + loader
    routes/not-found.tsx # Not-found page, wired from the manifest
    shells/public.tsx  # Layout wrapper
    api/health.ts      # Sample API endpoint
  vite.config.ts       # Vite + pracht plugin config
  package.json
```

A pages-router scaffold uses `src/pages/` instead:

```
my-app/
  src/
    pages/_app.tsx     # App shell
    pages/index.tsx    # First page component + loader
    pages/404.tsx      # Not-found page, wired automatically
    api/health.ts      # Sample API endpoint
  vite.config.ts       # Vite + pracht plugin config
  package.json
```

Depending on your choices, the starter also includes Tailwind's
`src/styles/global.css`, adapter files such as `wrangler.jsonc` or `Dockerfile`,
and agent files under `.claude/skills/` plus `.mcp.json`.

### TypeScript settings pracht requires

pracht's packages are ESM-only and publish their types through `exports`, so
`tsconfig.json` needs a resolver that reads it:

```json [tsconfig.json]
{
  "compilerOptions": {
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "types": ["vite/client", "@pracht/vite-plugin/virtual"]
  }
}
```

`"node16"` and `"nodenext"` work too. The legacy `"moduleResolution": "Node"`
does not: the app still builds and runs, but `tsc` fails every `@pracht/core`
import with `TS2307`. `create-pracht` scaffolds the right value, and
`pracht doctor` warns about the old one.

See [Import Paths](/docs/reference/api#import-paths) for the matching
`tsconfig.client.json`.

---

## Development

```sh
pnpm dev
```

Open `http://localhost:3000`, edit `src/routes/home.tsx`, and watch it update.

---

## Build Output

```sh
# Production build (client + server bundles, SSG prerendering)
pnpm build
```

The build writes `dist/client/` (static assets and prerendered pages) and
`dist/server/` (the server bundle in the shape your adapter needs). For a
Node.js target, run it directly:

```sh
node dist/server/server.js
```

---

## Deploy

Cloudflare, Netlify, and Vercel scaffolds include the platform config and a
`deploy` script.

### Cloudflare Workers — the shortest path

```sh
pnpm create pracht my-app --adapter=cf --yes
cd my-app
pnpm run deploy
```

The script runs `pracht build && wrangler deploy`. The first run opens a browser
to authorize Wrangler (in CI, set `CLOUDFLARE_API_TOKEN` instead), then prints
your `https://my-app.<your-subdomain>.workers.dev` URL.

> [!NOTE]
> Use `pnpm run deploy`, not `pnpm deploy`: pnpm has a built-in `deploy`
> command that would run instead of the script.

Add KV, D1, R2, or cron triggers in `wrangler.jsonc`; bindings arrive as
`context.env` in loaders and API routes. `pracht preview` serves the built app
locally through Wrangler.

### Vercel

```sh
pnpm create pracht my-app --adapter=vercel --yes
cd my-app
pnpm run deploy
```

The script runs `pracht build && vercel deploy --prebuilt`. The first deploy asks
which Vercel project to link.

### Everything else

Node.js (including Docker), Netlify, and static hosts are each one adapter swap
in `vite.config.ts`. See [Deployment](/docs/deployment) for per-platform
commands and [Adapters](/docs/adapters) for what each adapter emits.

---

## Next Steps

- **Route manifest** — `src/routes.ts` declares routes, shells, middleware, and render modes. See [Routing](/docs/routing).
- **Render modes** — each route can be SSR, SSG, ISG, or SPA. See [Rendering Modes](/docs/rendering).
- **Loaders & API routes** — server-side data fetching and mutations. See [Data Loading](/docs/data-loading).
- **Adapters** — deploy to Node.js, Cloudflare Workers, Netlify, Vercel, or a static host. See [Adapters](/docs/adapters).
- **Capabilities** — typed operations your app exposes to agents as well as to its own UI. See [The Agentic Web](/docs/agents).
