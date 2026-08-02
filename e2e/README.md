# E2E

Playwright coverage now exercises `examples/cloudflare` in the browser dev loop
plus the Cloudflare and Vercel deployment build outputs.

The `preact-v11-streaming` project is an isolated upstream experiment covering
streamed Suspense hydration races and Hydration 2.0's empty and multi-node
boundary cases. See
[`docs/PREACT_V11_STREAMING_EXPERIMENT.md`](../docs/PREACT_V11_STREAMING_EXPERIMENT.md)
for its evidence and limits.

Running `pnpm install` at the repo root also runs the `prepare` hook, which
installs the Playwright Chromium browser used by this suite.

The first pass of the scaffold focuses on the shared package boundaries:

- `pracht` for the manifest, routing, and runtime contracts
- `@pracht/vite-plugin` for virtual module generation
- `@pracht/adapter-node` for Node request/response bridging
- `@pracht/adapter-cloudflare` for Cloudflare Worker output
- `@pracht/adapter-vercel` for Vercel Build Output API output
- `@pracht/cli` for the command surface
