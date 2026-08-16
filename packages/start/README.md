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
- Scaffolds a minimal app with a route manifest or pages router, shell, home route, not-found page, sample API route, runnable project README, TypeScript typecheck script, and (with agent tooling enabled) agent instructions.
- Manifest scaffolds include a commented-out `constraints` example in `src/routes.ts`, ready for `pracht verify`.
- The generated `.gitignore` keeps `.pracht/app-graph.json` committable, and the README and agent instructions cover the `pracht verify` / `pracht plan` / `pracht report` loop.
- Every standalone pnpm scaffold includes a narrow lifecycle-script policy for
  its required native dependencies in `pnpm-workspace.yaml`:
  `onlyBuiltDependencies` for pnpm 10 or `allowBuilds` for pnpm 11. All adapters
  allow `esbuild`, Cloudflare also allows `workerd`, and Tailwind starters also
  allow `@tailwindcss/oxide`.
- Seeds the pracht Claude Code skills into `.claude/skills/`, writes a `.mcp.json` registering the `pracht mcp` server, and writes `AGENTS.md` (yes-default prompt; all of it skipped with `--no-agent-tools`, which leaves a project with no agent files at all).
- Initializes a git repository with an initial commit (skipped with `--no-git`, when git is unavailable, or when the target is already inside a repository).
- `--dry-run` uses pinned fallback versions and does not require npm registry access.

## Usage

```bash
node ./packages/start/bin/create-pracht.js
node ./packages/start/bin/create-pracht.js my-app --adapter=node --skip-install
node ./packages/start/bin/create-pracht.js my-app --adapter=vercel --skip-install
node ./packages/start/bin/create-pracht.js my-app --adapter=netlify --skip-install
node ./packages/start/bin/create-pracht.js my-app --template=tailwind --yes
node ./packages/start/bin/create-pracht.js my-app --adapter=node --no-tailwind --no-git --yes
```

## Options

- `--adapter=node|cf|netlify|vercel|static` — choose the hosting adapter (default: node).
  `static` scaffolds a pure static export (`@pracht/adapter-static`): no API route is
  generated, because a static export has no server to answer one.
- `--router=manifest|pages` — choose the routing system (default: manifest).
- `--template=minimal|tailwind` — non-interactive template selection; `minimal` is the default output, `tailwind` is minimal plus Tailwind CSS wiring.
- `--tailwind` / `--no-tailwind` — enable or disable Tailwind CSS without going through the prompt.
- `--agent-tools` / `--no-agent-tools` — seed the Claude Code skills, `.mcp.json`, and `AGENTS.md`/`CLAUDE.md` (or skip all of them) without going through the prompt.
- `--no-git` — skip `git init` and the initial commit.
- `--skip-install` — skip dependency installation.
- `--yes`, `-y` — accept defaults (node adapter, manifest router, no Tailwind, agent tooling on) and skip all prompts.
- `--json` — output a JSON summary instead of prose.
- `--dry-run` — list the files that would be created without writing anything.

## Generated Files

- `package.json`
- `vite.config.ts`
- `src/routes.ts`
- `src/routes/home.tsx`
- `src/routes/not-found.tsx` — the app's 404 page, wired via `notFound` in the manifest (pages scaffolds get `src/pages/404.tsx`, which pracht wires automatically)
- `src/shells/public.tsx`
- `src/api/health.ts`
- `.gitignore`
- `.claude/skills/<name>/SKILL.md` — the pracht agent skills (unless `--no-agent-tools`)
- `.mcp.json` — registers the `pracht mcp` server for MCP clients (unless `--no-agent-tools`)
- `AGENTS.md` (plus a `CLAUDE.md` symlink pointing at it) — project conventions for coding
  agents (unless `--no-agent-tools`; `README.md` documents the same commands for humans)

The skills are copied from the repo's [skills/](../../skills/README.md) directory into this
package at build/publish time (`scripts/sync-skills.js`), so the published npm tarball is
self-contained.

Node scaffolds also include:

- `Dockerfile` — multi-stage build (install → build → slim runtime) that runs `node dist/server/server.js`
- `.dockerignore`

Tailwind scaffolds also include:

- `src/styles/global.css` — the Tailwind entry stylesheet, imported by the shell

Cloudflare scaffolds also include:

- `wrangler.jsonc`

Standalone pnpm scaffolds for every adapter include `pnpm-workspace.yaml` with
the version-appropriate lifecycle policy. When the new app belongs to an
ancestor pnpm workspace, that workspace owns the policy instead: the generated
README and completion message list the exact entries to add and no nested
workspace file is created.

## Generated Scripts

- `dev` -> `pracht dev`
- `build` -> `pracht build`
- `typecheck` -> `tsc --noEmit`

Node starters also include:

- `preview` -> `pracht preview`
- `start` -> `node dist/server/server.js`

Cloudflare starters also include:

- `preview` -> `pracht preview`
- `deploy` -> `pracht build && wrangler deploy`

Vercel starters also include:

- `deploy` -> `pracht build && vercel deploy --prebuilt`
