---
"create-pracht": patch
---

Fix three things a freshly scaffolded app hit immediately.

- **Cloudflare URLs now match the other adapters.** The assets binding's default `html_handling` redirects every prerendered route to its trailing-slash form, so the same app answered `200` on Node and Vercel and `307` on Cloudflare — for every URL the generated `llms.txt` advertises. The scaffold's `wrangler.jsonc` sets `"html_handling": "drop-trailing-slash"`.
- **pnpm installs cleanly.** pnpm blocks dependency install scripts unless allowlisted, so a Cloudflare scaffold failed with `ERR_PNPM_IGNORED_BUILDS` for `workerd` (whose postinstall fetches the runtime binary) and `esbuild`. The scaffold now writes a `pnpm-workspace.yaml` with `allowBuilds` — the same form this repo uses, and the only one pnpm 11 reads (it ignores the `pnpm` field in package.json and warns about it). npm and yarn ignore the file. When the app lands inside an existing pnpm workspace the file is *not* written, because pnpm resolves the setting from the workspace root and a nested one would both be ignored and re-root the workspace for anyone installing from the app directory; the allowlist to add to the root config is printed instead.
- **The summary says what was scaffolded** — router, Tailwind, and agent tooling alongside the adapter — and a pages-router scaffold states up front that middleware, capabilities, constraints, and the agent surface are manifest-only. Its `AGENTS.md` no longer tells agents to run `pracht generate middleware` / `generate shell`, which are manifest-only commands.
