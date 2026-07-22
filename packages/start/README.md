# create-pracht

Interactive starter CLI for bootstrapping a new pracht app.

## Quickstart

```bash
npm create pracht@latest my-app
cd my-app
npm install
npm run dev
```

## What It Does

- Prompts for the target folder.
- Detects the active package manager from the current environment.
- Lets the user choose between the Node.js, Cloudflare, and Vercel adapters.
- Optionally wires up Tailwind CSS (`tailwindcss` + `@tailwindcss/vite`, a global stylesheet, and the shell import).
- Scaffolds a minimal app with a route manifest or pages router, shell, home route, sample API route, runnable project README, and agent instructions.
- Manifest scaffolds include a commented-out `constraints` example in `src/routes.ts`, ready for `pracht verify`.
- The generated `.gitignore` keeps `.pracht/app-graph.json` committable, and the README and agent instructions cover the `pracht verify` / `pracht plan` / `pracht report` loop.
- Initializes a git repository with an initial commit (skipped with `--no-git`, when git is unavailable, or when the target is already inside a repository).
- `--dry-run` uses pinned fallback versions and does not require npm registry access.

## Usage

```bash
node ./packages/start/bin/create-pracht.js
node ./packages/start/bin/create-pracht.js my-app --adapter=node --skip-install
node ./packages/start/bin/create-pracht.js my-app --adapter=vercel --skip-install
node ./packages/start/bin/create-pracht.js my-app --template=tailwind --yes
node ./packages/start/bin/create-pracht.js my-app --adapter=node --no-tailwind --no-git --yes
```

## Options

- `--adapter=node|cf|vercel` — choose the hosting adapter (default: node).
- `--router=manifest|pages` — choose the routing system (default: manifest).
- `--template=minimal|tailwind` — non-interactive template selection; `minimal` is the default output, `tailwind` is minimal plus Tailwind CSS wiring.
- `--tailwind` / `--no-tailwind` — enable or disable Tailwind CSS without going through the prompt.
- `--no-git` — skip `git init` and the initial commit.
- `--skip-install` — skip dependency installation.
- `--yes`, `-y` — accept defaults (node adapter, manifest router, no Tailwind) and skip all prompts.
- `--json` — output a JSON summary instead of prose.
- `--dry-run` — list the files that would be created without writing anything.

## Generated Files

- `package.json`
- `vite.config.ts`
- `src/routes.ts`
- `src/routes/home.tsx`
- `src/shells/public.tsx`
- `src/api/health.ts`
- `.gitignore`

Node scaffolds also include:

- `Dockerfile` — multi-stage build (install → build → slim runtime) that runs `node dist/server/server.js`
- `.dockerignore`

Tailwind scaffolds also include:

- `src/styles/global.css` — the Tailwind entry stylesheet, imported by the shell

Cloudflare scaffolds also include:

- `wrangler.jsonc`

## Generated Scripts

- `dev` -> `pracht dev`
- `build` -> `pracht build`

Node starters also include:

- `preview` -> `pracht preview`
- `start` -> `node dist/server/server.js`

Cloudflare starters also include:

- `preview` -> `pracht preview`
- `deploy` -> `pracht build && wrangler deploy`

Vercel starters also include:

- `deploy` -> `pracht build && vercel deploy --prebuilt`
