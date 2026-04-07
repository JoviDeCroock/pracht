# E2E

Playwright coverage now exercises `examples/cloudflare` in the browser dev loop
plus the Cloudflare and Vercel deployment build outputs.

The first pass of the scaffold focuses on the shared package boundaries:

- `previte` for the manifest, routing, and runtime contracts
- `@previte/vite-plugin` for virtual module generation
- `@previte/adapter-node` for Node request/response bridging
- `@previte/adapter-cloudflare` for Cloudflare Worker output
- `@previte/adapter-vercel` for Vercel Build Output API output
- `@previte/cli` for the command surface
