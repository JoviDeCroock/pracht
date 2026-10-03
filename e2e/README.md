# E2E

Playwright coverage now exercises `examples/cloudflare` in the browser dev loop
plus the Cloudflare and Vercel deployment build outputs.

Running `pnpm install` at the repo root also runs the `prepare` hook, which
installs the Playwright Chromium browser used by this suite.

A failing CI run uploads `test-results/` as the `playwright-test-results`
artifact, with a trace for every failed test; open one with
`pnpm exec playwright show-trace <path>/trace.zip`. Locally, the retry of a
failed test records the trace.

The first pass of the scaffold focuses on the shared package boundaries:

- `pracht` for the manifest, routing, and runtime contracts
- `@pracht/vite-plugin` for virtual module generation
- `@pracht/adapter-node` for Node request/response bridging
- `@pracht/adapter-cloudflare` for Cloudflare Worker output
- `@pracht/adapter-vercel` for Vercel Build Output API output
- `@pracht/cli` for the command surface
